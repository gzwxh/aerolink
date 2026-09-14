package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/go-ldap/ldap/v3"
	"github.com/zxh326/kite/pkg/model"
	"k8s.io/klog/v2"
)

const (
	ldapSyncPageSize     = 500
	ldapSyncPollInterval = time.Minute
)

type LDAPSyncResult struct {
	StartedAt      time.Time `json:"startedAt"`
	FinishedAt     time.Time `json:"finishedAt"`
	TotalUsers     int       `json:"totalUsers"`
	Created        int       `json:"created"`
	Updated        int       `json:"updated"`
	Failed         int       `json:"failed"`
	Purged         int       `json:"purged"`
	EnableImported bool      `json:"enableImported"`
	Error          string    `json:"error,omitempty"`
}

type LDAPSyncStatus struct {
	Running             bool            `json:"running"`
	Enabled             bool            `json:"enabled"`
	AutoSync            bool            `json:"autoSync"`
	SyncIntervalMinutes int             `json:"syncIntervalMinutes"`
	LastSyncAt          *time.Time      `json:"lastSyncAt,omitempty"`
	LastResult          *LDAPSyncResult `json:"lastResult,omitempty"`
}

type ldapSyncRequest struct{}

type ldapSyncer struct {
	requests  chan ldapSyncRequest
	startOnce sync.Once

	mu         sync.Mutex
	running    bool
	lastRunAt  *time.Time
	lastResult *LDAPSyncResult
	nextAuto   time.Time
}

var globalLDAPSyncer = &ldapSyncer{requests: make(chan ldapSyncRequest, 8)}

// StartLDAPSync starts the periodic background LDAP sync worker. Periodic sync
// only aligns previously imported users; it never provisions new accounts.
func StartLDAPSync(ctx context.Context) {
	globalLDAPSyncer.startOnce.Do(func() {
		go globalLDAPSyncer.run(ctx)
	})
}

// TriggerLDAPSync requests a best-effort alignment sync (no new users are
// created). Used after LDAP settings are saved. Non-blocking.
func TriggerLDAPSync() {
	select {
	case globalLDAPSyncer.requests <- ldapSyncRequest{}:
	default:
	}
}

// StartManualLDAPSync requests an immediate alignment sync. Reports false if a
// sync request is already queued or running.
func StartManualLDAPSync() bool {
	select {
	case globalLDAPSyncer.requests <- ldapSyncRequest{}:
		return true
	default:
		return false
	}
}

// GetLDAPSyncStatus returns the current running state and the last result.
func GetLDAPSyncStatus() LDAPSyncStatus {
	setting, err := model.GetLDAPSetting()
	status := LDAPSyncStatus{}
	if err == nil {
		status.Enabled = setting.Enabled
		status.AutoSync = setting.AutoSync
		status.SyncIntervalMinutes = setting.SyncIntervalMinutes
	}
	globalLDAPSyncer.mu.Lock()
	defer globalLDAPSyncer.mu.Unlock()
	status.Running = globalLDAPSyncer.running
	status.LastSyncAt = globalLDAPSyncer.lastRunAt
	if globalLDAPSyncer.lastResult != nil {
		copy := *globalLDAPSyncer.lastResult
		status.LastResult = &copy
	}
	return status
}

func (s *ldapSyncer) run(ctx context.Context) {
	ticker := time.NewTicker(ldapSyncPollInterval)
	defer ticker.Stop()
	lastKey := ""
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.requests:
			s.runIfEnabled(ctx)
			// Refresh lastKey so the poll tick does not immediately treat the
			// settings change as new and run a duplicate sync.
			setting, err := model.GetLDAPSetting()
			if err != nil || !setting.Enabled || !setting.AutoSync {
				lastKey = ""
			} else {
				lastKey = ldapSyncKey(setting)
			}
		case <-ticker.C:
			setting, err := model.GetLDAPSetting()
			if err != nil {
				continue
			}
			if !setting.Enabled || !setting.AutoSync {
				lastKey = ""
				continue
			}
			key := ldapSyncKey(setting)
			s.mu.Lock()
			due := s.nextAuto.IsZero() || time.Now().After(s.nextAuto)
			s.mu.Unlock()
			if key != lastKey || due {
				s.runIfEnabled(ctx)
				lastKey = key
			}
		}
	}
}

func (s *ldapSyncer) runIfEnabled(ctx context.Context) {
	setting, err := model.GetLDAPSetting()
	if err != nil {
		klog.Warningf("LDAP sync: failed to load settings: %v", err)
		return
	}
	if !setting.Enabled {
		return
	}
	s.runOnce(ctx, setting)
}

func (s *ldapSyncer) runOnce(ctx context.Context, setting *model.LDAPSetting) {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		klog.V(1).Info("LDAP sync already running, skipping request")
		return
	}
	s.running = true
	s.mu.Unlock()

	result := s.syncAll(ctx, setting)
	result.FinishedAt = time.Now()

	interval := time.Duration(setting.SyncIntervalMinutes) * time.Minute
	if interval <= 0 {
		interval = time.Duration(model.DefaultLDAPSyncIntervalMinutes) * time.Minute
	}
	s.mu.Lock()
	s.running = false
	s.lastRunAt = &result.StartedAt
	s.lastResult = result
	s.nextAuto = time.Now().Add(interval)
	s.mu.Unlock()
}

func (s *ldapSyncer) syncAll(ctx context.Context, setting *model.LDAPSetting) *LDAPSyncResult {
	result := &LDAPSyncResult{StartedAt: time.Now()}

	cfg, err := newLDAPConfig(setting)
	if err != nil {
		result.Error = err.Error()
		return result
	}

	// Periodic / manual "sync" only aligns users that were explicitly imported
	// through the interactive picker — it never provisions new users itself.
	entries, err := searchDirectoryEntries(cfg)
	if err != nil {
		result.Error = err.Error()
		return result
	}

	local, err := model.ListLDAPUsers()
	if err != nil {
		result.Error = fmt.Sprintf("failed to load local ldap users: %v", err)
		return result
	}
	existing := make(map[string]struct{}, len(local))
	for _, u := range local {
		existing[u.Username] = struct{}{}
	}

	conn, err := bindLDAPServiceConnection(cfg)
	if err != nil {
		result.Error = err.Error()
		return result
	}
	defer func() {
		_ = conn.Close()
	}()

	present := make(map[string]struct{}, len(entries))
	for _, e := range entries {
		if ctxErr := ctx.Err(); ctxErr != nil {
			result.Error = "ldap sync cancelled"
			return result
		}
		username := strings.TrimSpace(e.username)
		if username == "" {
			result.Failed++
			continue
		}
		present[username] = struct{}{}
		if _, ok := existing[username]; !ok {
			// Not imported yet — creation happens through the import picker only.
			continue
		}
		result.TotalUsers++

		groups, err := findLDAPGroups(conn, cfg, e.dn)
		if err != nil {
			result.Failed++
			klog.Warningf("LDAP sync: failed to resolve groups for %s: %v", username, err)
			continue
		}
		if _, err := model.SyncLDAPUser(&model.User{
			Username:   username,
			Name:       e.displayName,
			OIDCGroups: groups,
		}, false); err != nil {
			result.Failed++
			klog.Warningf("LDAP sync: failed to update user %s: %v", username, err)
			continue
		}
		result.Updated++
	}

	// Only clean up disabled accounts when the directory enumeration was
	// healthy, so a transient failure never deletes local records.
	if result.Failed == 0 {
		purged, err := purgeDisabledMissingUsers(present)
		if err != nil {
			klog.Warningf("LDAP sync: failed to purge disabled missing users: %v", err)
		} else {
			result.Purged = purged
		}
	}

	klog.Infof("LDAP sync finished: total=%d updated=%d failed=%d purged=%d",
		result.TotalUsers, result.Updated, result.Failed, result.Purged)
	return result
}

// purgeDisabledMissingUsers physically removes locally disabled LDAP accounts
// that are no longer returned by the directory. Disabled users that still exist
// in LDAP stay untouched (the admin can re-enable them any time).
func purgeDisabledMissingUsers(present map[string]struct{}) (int, error) {
	disabled, err := model.ListDisabledLDAPUsers()
	if err != nil {
		return 0, err
	}
	purged := 0
	for _, u := range disabled {
		if _, ok := present[u.Username]; ok {
			continue
		}
		if err := model.DeleteUserByID(u.ID); err != nil {
			klog.Warningf("LDAP sync: failed to purge user %s: %v", u.Username, err)
			continue
		}
		purged++
		klog.Infof("LDAP sync: purged disabled user %s (no longer in directory)", u.Username)
	}
	return purged, nil
}

// ldapDirectoryEntry is a lightweight representation of a directory user found
// by the batch search (the user filter with its %s placeholder widened to *).
type ldapDirectoryEntry struct {
	username    string
	displayName string
	dn          string
}

func searchDirectoryEntries(cfg ldapConfig) ([]ldapDirectoryEntry, error) {
	conn, err := bindLDAPServiceConnection(cfg)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = conn.Close()
	}()

	listFilter, err := formatLDAPFilter(cfg.UserFilter, "*")
	if err != nil {
		return nil, fmt.Errorf("invalid user filter for directory search: %w", err)
	}
	req := ldap.NewSearchRequest(
		cfg.UserBaseDN,
		ldap.ScopeWholeSubtree,
		ldap.NeverDerefAliases,
		0, 0, false,
		listFilter,
		[]string{cfg.UsernameAttribute, cfg.DisplayNameAttribute},
		nil,
	)
	res, err := conn.SearchWithPaging(req, ldapSyncPageSize)
	if err != nil {
		return nil, fmt.Errorf("failed to search ldap users: %w", err)
	}
	entries := make([]ldapDirectoryEntry, 0, len(res.Entries))
	for _, entry := range res.Entries {
		entries = append(entries, ldapDirectoryEntry{
			username:    strings.TrimSpace(entry.GetAttributeValue(cfg.UsernameAttribute)),
			displayName: strings.TrimSpace(entry.GetAttributeValue(cfg.DisplayNameAttribute)),
			dn:          entry.DN,
		})
	}
	return entries, nil
}

// LDAPImportCandidate is one directory user offered for interactive selection.
type LDAPImportCandidate struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	// Imported means a local provider=ldap record already exists.
	Imported bool `json:"imported"`
	// Conflict means the username is already taken by a user of another provider
	// (password or an OIDC provider) and cannot be provisioned from LDAP.
	Conflict bool `json:"conflict"`
}

// ListLDAPImportCandidates enumerates directory users together with their local
// import state so the UI can offer them for interactive selection/import.
func ListLDAPImportCandidates(setting *model.LDAPSetting) ([]LDAPImportCandidate, error) {
	cfg, err := newLDAPConfig(setting)
	if err != nil {
		return nil, err
	}
	entries, err := searchDirectoryEntries(cfg)
	if err != nil {
		return nil, err
	}

	local, err := model.ListLDAPUsers()
	if err != nil {
		return nil, fmt.Errorf("failed to load local ldap users: %w", err)
	}
	imported := make(map[string]struct{}, len(local))
	for _, u := range local {
		imported[u.Username] = struct{}{}
	}

	candidates := make([]LDAPImportCandidate, 0, len(entries))
	for _, e := range entries {
		if e.username == "" {
			continue
		}
		c := LDAPImportCandidate{Username: e.username, DisplayName: e.displayName}
		if _, ok := imported[e.username]; ok {
			c.Imported = true
		} else if existing, err := model.GetUserByUsername(e.username); err == nil && existing.Provider != model.AuthProviderLDAP {
			c.Conflict = true
		}
		candidates = append(candidates, c)
	}
	return candidates, nil
}

// LDAPImportResult summarizes an interactive import run.
type LDAPImportResult struct {
	Created     int      `json:"created"`
	Updated     int      `json:"updated"`
	NotFound    int      `json:"notFound"`
	Conflicted  int      `json:"conflicted"`
	Failed      int      `json:"failed"`
	FailedUsers []string `json:"failedUsers,omitempty"`
}

// ImportLDAPUsers provisions the requested directory users. Existing LDAP
// records are aligned (name/groups refreshed) and keep their enabled state;
// brand-new users are created with the caller's enableImported choice.
func ImportLDAPUsers(setting *model.LDAPSetting, usernames []string, enableImported bool) (LDAPImportResult, error) {
	var res LDAPImportResult

	cfg, err := newLDAPConfig(setting)
	if err != nil {
		return res, err
	}
	conn, err := bindLDAPServiceConnection(cfg)
	if err != nil {
		return res, err
	}
	defer func() {
		_ = conn.Close()
	}()

	seen := make(map[string]struct{}, len(usernames))
	for _, raw := range usernames {
		requested := strings.TrimSpace(raw)
		if requested == "" {
			continue
		}
		if _, ok := seen[requested]; ok {
			continue
		}
		seen[requested] = struct{}{}

		entry, err := findLDAPUser(conn, cfg, requested)
		if err != nil {
			if errors.Is(err, ErrLDAPInvalidCredentials) {
				res.NotFound++
				res.FailedUsers = append(res.FailedUsers, requested)
			} else {
				res.Failed++
				res.FailedUsers = append(res.FailedUsers, requested)
			}
			continue
		}
		username := strings.TrimSpace(entry.GetAttributeValue(cfg.UsernameAttribute))
		if username == "" {
			username = requested
		}
		groups, err := findLDAPGroups(conn, cfg, entry.DN)
		if err != nil {
			res.Failed++
			res.FailedUsers = append(res.FailedUsers, username)
			klog.Warningf("LDAP import: failed to resolve groups for %s: %v", username, err)
			continue
		}
		displayName := strings.TrimSpace(entry.GetAttributeValue(cfg.DisplayNameAttribute))
		created, err := model.SyncLDAPUser(&model.User{
			Username:   username,
			Name:       displayName,
			OIDCGroups: groups,
		}, enableImported)
		if err != nil {
			if errors.Is(err, model.ErrUserProviderConflict) {
				res.Conflicted++
			} else {
				res.Failed++
			}
			res.FailedUsers = append(res.FailedUsers, username)
			continue
		}
		if created {
			res.Created++
		} else {
			res.Updated++
		}
	}
	return res, nil
}

// ldapSyncKey returns a signature of the LDAP settings so the worker can detect
// changes (e.g. a config file reload) and re-sync promptly.
func ldapSyncKey(s *model.LDAPSetting) string {
	if s == nil {
		return ""
	}
	parts := []string{
		s.ServerURL,
		s.UserBaseDN, s.UserFilter, s.UsernameAttribute, s.DisplayNameAttribute,
		s.GroupBaseDN, s.GroupFilter, s.GroupNameAttribute,
		s.BindDN,
		fmt.Sprintf("%t", s.UseStartTLS),
		fmt.Sprintf("%t", s.AutoSync),
		fmt.Sprintf("%d", s.SyncIntervalMinutes),
	}
	return strings.Join(parts, "\x00")
}
