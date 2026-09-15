package model

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/utils"
	"k8s.io/klog/v2"
)

// encryptedColumns lists every column stored as a SecretString (AES-GCM).
// Keep it in sync with the SecretString fields in this package.
var encryptedColumns = []struct{ Table, Column string }{
	{"users", "api_key"},
	{"users", "mfa_secret"},
	{"clusters", "config"},
	{"clusters", "cluster_agent_private_key"},
	{"general_settings", "ai_api_key"},
	{"general_settings", "jwt_secret"},
	{"helm_repositories", "password"},
	{"ldap_settings", "bind_password"},
	{"notification_settings", "smtp_password"},
	{"oauth_providers", "client_secret"},
}

func encryptionKeyFingerprint(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

// EnsureEncryptionKey reconciles the configured KITE_ENCRYPT_KEY with the key
// that actually encrypted the stored secrets.
//
// The database remembers a fingerprint of the key in use, which allows a
// deployment to move off the built-in default key without losing data: the
// stored ciphertext is rewritten with the configured key. If the key was
// changed to something the data was never encrypted with, that is reported
// loudly instead of letting every credential fail to decrypt one by one.
func EnsureEncryptionKey() {
	if DB == nil {
		return
	}

	current := common.KiteEncryptKey
	fingerprint := encryptionKeyFingerprint(current)
	previous, err := storedEncryptionKeyFingerprint()
	if err != nil {
		klog.Warningf("failed to read the stored encryption key fingerprint: %v", err)
		return
	}
	if previous == fingerprint {
		return
	}

	// The fingerprint alone is not enough: it is absent on the first start of
	// this mechanism and was never written by older versions. Decide from the
	// stored ciphertext instead — if the configured key can read the data
	// there is nothing to do, and if only the built-in key can, the data is
	// migrated onto the configured key.
	hasData, readableWithCurrent := probeEncryptionKey(current)
	switch {
	case !hasData || readableWithCurrent:
		if err := saveEncryptionKeyFingerprint(fingerprint); err != nil {
			klog.Warningf("failed to record the encryption key fingerprint: %v", err)
		}
		return
	case current == common.DefaultKiteEncryptKey:
		// Nothing to migrate to; the built-in key is simply wrong to use.
		klog.Warningf("stored secrets cannot be read with the built-in encryption key")
	default:
		if defaultReadable, _ := probeEncryptionKey(common.DefaultKiteEncryptKey); defaultReadable {
			migrated, err := migrateEncryptedColumns(common.DefaultKiteEncryptKey, current)
			if err != nil {
				// Nothing was written (the migration is atomic): the previous
				// key still opens every stored secret.
				klog.Errorf("failed to re-encrypt stored secrets with KITE_ENCRYPT_KEY: %v. "+
					"Stored secrets are unchanged and readable with the previously configured key; "+
					"restore that KITE_ENCRYPT_KEY (or re-save every credential before switching).", err)
				return
			}
			if err := saveEncryptionKeyFingerprint(fingerprint); err != nil {
				klog.Errorf("secrets were re-encrypted but the key fingerprint could not be stored: %v", err)
				return
			}
			klog.Warningf("KITE_ENCRYPT_KEY is now configured: re-encrypted %d stored secret(s) that used the built-in key", migrated)
			return
		}
		klog.Errorf("KITE_ENCRYPT_KEY does not match the key that encrypted the stored data. " +
			"Secrets (cluster kubeconfigs, LDAP/SMTP/OAuth passwords, AI keys) will fail to decrypt. " +
			"Restore the previous key, or start with the old key, re-save every credential, then switch.")
	}
}

// probeEncryptionKey reports whether any encrypted column holds data and
// whether that data can be read with the given key.
func probeEncryptionKey(key string) (hasData bool, readable bool) {
	for _, column := range encryptedColumns {
		var value string
		query := fmt.Sprintf("SELECT %s FROM %s WHERE %s IS NOT NULL AND %s <> '' LIMIT 1",
			column.Column, column.Table, column.Column, column.Column)
		if err := DB.Raw(query).Scan(&value).Error; err != nil || value == "" {
			continue // table missing or column empty
		}
		hasData = true
		if _, err := utils.DecryptStringWithKey(key, value); err == nil {
			return true, true
		}
	}
	return hasData, false
}

// storedEncryptionKeyFingerprint reads the marker with raw SQL: the general
// setting row cannot be loaded through GORM when its encrypted columns use a
// key other than the configured one.
func storedEncryptionKeyFingerprint() (string, error) {
	var fingerprint string
	row := DB.Raw("SELECT encrypt_key_fingerprint FROM general_settings WHERE id = 1").Row()
	if err := row.Scan(&fingerprint); err != nil {
		// The table or the singleton row may not exist yet on a fresh install.
		if errors.Is(err, sql.ErrNoRows) || strings.Contains(err.Error(), "no such table") {
			return "", nil
		}
		return "", err
	}
	return strings.TrimSpace(fingerprint), nil
}

func saveEncryptionKeyFingerprint(fingerprint string) error {
	return DB.Exec("UPDATE general_settings SET encrypt_key_fingerprint = ? WHERE id = 1", fingerprint).Error
}

// migrateEncryptedColumns rewrites every SecretString column from one key to
// another, atomically: a single failure rolls the whole migration back so the
// database is never left with a mix of old and new ciphertext.
func migrateEncryptedColumns(oldKey, newKey string) (int, error) {
	migrated := 0
	tx := DB.Begin()
	if tx.Error != nil {
		return 0, tx.Error
	}
	defer func() {
		if r := recover(); r != nil {
			tx.Rollback()
			panic(r)
		}
	}()

	for _, column := range encryptedColumns {
		type row struct {
			ID    uint
			Value string
		}
		var rows []row
		query := fmt.Sprintf("SELECT id, %s AS value FROM %s WHERE %s IS NOT NULL AND %s <> ''",
			column.Column, column.Table, column.Column, column.Column)
		if err := tx.Raw(query).Scan(&rows).Error; err != nil {
			if strings.Contains(err.Error(), "no such table") {
				continue // feature never used on this installation
			}
			tx.Rollback()
			return 0, fmt.Errorf("reading %s.%s: %w", column.Table, column.Column, err)
		}
		for _, r := range rows {
			plaintext, err := utils.DecryptStringWithKey(oldKey, r.Value)
			if err != nil {
				tx.Rollback()
				return 0, fmt.Errorf("decrypting %s.%s id=%d: %w", column.Table, column.Column, r.ID, err)
			}
			encrypted, err := utils.EncryptStringWithKey(newKey, plaintext)
			if err != nil {
				tx.Rollback()
				return 0, fmt.Errorf("encrypting %s.%s id=%d: %w", column.Table, column.Column, r.ID, err)
			}
			update := fmt.Sprintf("UPDATE %s SET %s = ? WHERE id = ?", column.Table, column.Column)
			if err := tx.Exec(update, encrypted, r.ID).Error; err != nil {
				tx.Rollback()
				return 0, fmt.Errorf("writing %s.%s id=%d: %w", column.Table, column.Column, r.ID, err)
			}
			migrated++
		}
	}

	if err := tx.Commit().Error; err != nil {
		return 0, err
	}
	return migrated, nil
}
