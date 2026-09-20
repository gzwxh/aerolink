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

// encryptedColumns 列出所有以 SecretString（AES-GCM）存储的列。
// 需要与本包中的 SecretString 字段保持同步。
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

// EnsureEncryptionKey 让配置的 KITE_ENCRYPT_KEY 与真正加密了已存密钥的
// 那个 key 保持一致。
//
// 数据库会记住在用密钥的指纹，这样部署可以从内置默认密钥切换出去而不丢数据：
// 已存的密文会用配置好的密钥重写。如果密钥被改成了一个从未用于加密该数据的密钥，
// 会明确报错，
// 而不是让每一条凭据逐个解密失败。
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

	// 仅靠指纹还不够：这套机制首次启动时指纹并不存在，旧版本也从未写入过。
	// 因此改为依据已存密文来判断——如果配置的密钥能读出数据就什么都不做；
	// 如果只有内置密钥能读出，
	// 就把数据迁移到配置的密钥上。
	//
	hasData, readableWithCurrent := probeEncryptionKey(current)
	switch {
	case !hasData || readableWithCurrent:
		if err := saveEncryptionKeyFingerprint(fingerprint); err != nil {
			klog.Warningf("failed to record the encryption key fingerprint: %v", err)
		}
		// 指纹列就在 general_settings 行上，而这里是裸 SQL 写入（读不出来就没法走
		// 模型钩子），所以手动让读缓存失效。
		InvalidateGeneralSettingCache()
		return
	case current == common.DefaultKiteEncryptKey:
		// 没有可迁移的目标：内置密钥本就不该继续使用。
		klog.Warningf("stored secrets cannot be read with the built-in encryption key")
	default:
		if defaultReadable, _ := probeEncryptionKey(common.DefaultKiteEncryptKey); defaultReadable {
			migrated, err := migrateEncryptedColumns(common.DefaultKiteEncryptKey, current)
			if err != nil {
				// 什么都没有写入（迁移是原子的）：之前的
				// 密钥依然能解开所有已存密钥。
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
			// 刚用裸 SQL 重写了 general_settings 的加密列（jwt_secret / ai_api_key），
			// 缓存里那份是旧密文解出来的值，必须回源——启动流程正是靠随后的重读把
			// 库里的会话密钥推回内存（见 loadGeneralSettingAfterKeyMigration）。
			InvalidateGeneralSettingCache()
			return
		}
		klog.Errorf("KITE_ENCRYPT_KEY does not match the key that encrypted the stored data. " +
			"Secrets (cluster kubeconfigs, LDAP/SMTP/OAuth passwords, AI keys) will fail to decrypt. " +
			"Restore the previous key, or start with the old key, re-save every credential, then switch.")
	}
}

// probeEncryptionKey 报告是否存在存了数据的加密列，以及这些数据
// 能否用给定密钥读出。
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

// storedEncryptionKeyFingerprint 用裸 SQL 读取标记：当 general setting 那一行的
// 加密列用的是非配置密钥时，它无法通过 GORM 加载。
func storedEncryptionKeyFingerprint() (string, error) {
	// 标记为 NULL 表示"尚未记录"，而不是失败：AutoMigrate 会把该列加到
	// 这套机制出现之前创建的数据库上，并让已有行保持 NULL。
	// 把它当成错误会跳过这个标记本来要触发的迁移。
	//
	// 全新安装时表还不存在（AutoMigrate 会建），按「尚未记录」处理。
	// 用 HasTable 判断，而不是匹配错误文本：各驱动的措辞不同（sqlite 是
	// "no such table"，PostgreSQL 是 `relation "x" does not exist`），
	// 按文本匹配等于只有 sqlite 生效。
	if !DB.Migrator().HasTable("general_settings") {
		return "", nil
	}
	var fingerprint sql.NullString
	row := DB.Raw("SELECT encrypt_key_fingerprint FROM general_settings WHERE id = 1").Row()
	if err := row.Scan(&fingerprint); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", nil
		}
		return "", err
	}
	if !fingerprint.Valid {
		return "", nil
	}
	return strings.TrimSpace(fingerprint.String), nil
}

func saveEncryptionKeyFingerprint(fingerprint string) error {
	return DB.Exec("UPDATE general_settings SET encrypt_key_fingerprint = ? WHERE id = 1", fingerprint).Error
}

// migrateEncryptedColumns 把所有 SecretString 列从一个密钥重写到
// 另一个密钥，且是原子的：任何一处失败就整体回滚，
// 数据库绝不会留下新旧密文混杂的状态。
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
		// 该功能在这套安装里从未用过，表不存在就跳过。同样不能用错误文本判断：
		// PostgreSQL 上 `no such table` 永远匹配不到，会从「跳过」变成「迁移失败」。
		if !tx.Migrator().HasTable(column.Table) {
			continue
		}
		var rows []row
		query := fmt.Sprintf("SELECT id, %s AS value FROM %s WHERE %s IS NOT NULL AND %s <> ''",
			column.Column, column.Table, column.Column, column.Column)
		if err := tx.Raw(query).Scan(&rows).Error; err != nil {
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
