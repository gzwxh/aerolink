package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"aerolink/pkg/model"
	"github.com/go-ldap/ldap/v3"
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

// StartLDAPSync 启动周期性的 LDAP 后台同步任务。周期性同步
// 只对齐此前已导入的用户，从不开通新账号。
func StartLDAPSync(ctx context.Context) {
	globalLDAPSyncer.startOnce.Do(func() {
		go globalLDAPSyncer.run(ctx)
	})
}

// TriggerLDAPSync 请求一次尽力而为的对齐同步（不会创建新用户）。
// 在保存 LDAP 设置之后调用。非阻塞。
func TriggerLDAPSync() {
	select {
	case globalLDAPSyncer.requests <- ldapSyncRequest{}:
	default:
	}
}

// StartManualLDAPSync 请求一次立即执行的对齐同步。若已有同步请求在排队或运行中，返回 false。
func StartManualLDAPSync() bool {
	select {
	case globalLDAPSyncer.requests <- ldapSyncRequest{}:
		return true
	default:
		return false
	}
}

// GetLDAPSyncStatus 返回当前的运行状态与最近一次结果。
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
			// 刷新 lastKey，这样轮询的 tick 不会立刻把这次配置变更
			// 当成新配置而重复执行一次同步。
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

	// 周期性 / 手动"同步"只对齐那些通过交互式选择器明确导入过的用户——
	// 它自己从不开通新用户。
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
			// 尚未导入——创建只通过导入选择器进行。
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
			Email:      e.email,
			Phone:      e.phone,
			OIDCGroups: groups,
		}, false); err != nil {
			result.Failed++
			klog.Warningf("LDAP sync: failed to update user %s: %v", username, err)
			continue
		}
		result.Updated++
	}

	// 只有在目录枚举健康时才清理被停用的账号，
	// 这样一次临时故障不会删除本地记录。
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

// purgeDisabledMissingUsers 物理删除目录已不再返回的、本地被停用的 LDAP 账号。
// 在 LDAP 中仍然存在的被停用用户不会被处理
// （管理员随时可以重新启用它们）。
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

// ldapDirectoryEntry 是批量搜索（把用户过滤条件中的 %s 占位符放宽为 *）
// 找到的目录用户的轻量表示。
type ldapDirectoryEntry struct {
	username    string
	displayName string
	email       string
	phone       string
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
		ldapUserSearchAttributes(cfg),
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
			email:       ldapEntryEmail(entry),
			phone:       ldapEntryPhone(entry),
			dn:          entry.DN,
		})
	}
	return entries, nil
}

// LDAPImportCandidate 是供交互式选择的一个目录用户。
type LDAPImportCandidate struct {
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	// Imported 表示本地已存在 provider=ldap 的记录。
	Imported bool `json:"imported"`
	// Conflict 表示用户名已被其它 provider（password 或某个 OIDC 提供方）的用户占用，
	// 无法从 LDAP 开通。
	Conflict bool `json:"conflict"`
}

// ListLDAPImportCandidates 枚举目录用户及其本地导入状态，
// 以便界面把它们列出来供交互式选择/导入。
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

// LDAPImportResult 汇总一次交互式导入的结果。
type LDAPImportResult struct {
	Created     int      `json:"created"`
	Updated     int      `json:"updated"`
	NotFound    int      `json:"notFound"`
	Conflicted  int      `json:"conflicted"`
	Failed      int      `json:"failed"`
	FailedUsers []string `json:"failedUsers,omitempty"`
}

// ImportLDAPUsers 开通请求的目录用户。已有的 LDAP 记录会被对齐
// （刷新名称/所属组）并保留其启用状态；
// 全新用户按调用方的 enableImported 选择来创建。
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
			Email:      ldapEntryEmail(entry),
			Phone:      ldapEntryPhone(entry),
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

// ldapSyncKey 返回 LDAP 设置的签名，便于后台任务察觉配置变更
// （例如配置文件重载）并及时重新同步。
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
