package bindinggroups

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// setupHandlerTestDB 准备一个空的内存库，并返回 handler。
// cm 为 nil：被测试的路由都不访问集群客户端。
func setupHandlerTestDB(t *testing.T) *Handler {
	t.Helper()
	originalDB := model.DB
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		t.Fatalf("opening test database: %v", err)
	}
	if err := db.Exec("PRAGMA foreign_keys = ON").Error; err != nil {
		t.Fatalf("enabling foreign keys: %v", err)
	}
	if err := db.AutoMigrate(
		&model.User{},
		&model.Role{},
		&model.BindingGroup{},
		&model.BindingGroupNamespace{},
		&model.BindingGroupMember{},
	); err != nil {
		t.Fatalf("migrating test database: %v", err)
	}
	model.DB = db
	gin.SetMode(gin.TestMode)
	t.Cleanup(func() { model.DB = originalDB })
	return NewHandler(nil)
}

func doRequest(t *testing.T, h gin.HandlerFunc, method, target, body string, params gin.Params) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = bytes.NewBufferString(body)
	}
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(method, target, reader)
	c.Request.Header.Set("Content-Type", "application/json")
	c.Params = params
	h(c)
	return recorder
}

func jsonBody(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("encoding request body: %v", err)
	}
	return string(encoded)
}

func idParam(id uint) gin.Params {
	return gin.Params{{Key: "id", Value: strconv.FormatUint(uint64(id), 10)}}
}

func createGroup(t *testing.T, h *Handler, cluster, name string) model.BindingGroup {
	t.Helper()
	rec := doRequest(t, h.CreateBindingGroup, http.MethodPost, "/api/v1/admin/binding-groups/",
		jsonBody(t, map[string]any{"cluster": cluster, "name": name}), nil)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create binding group %s/%s: status %d body %s", cluster, name, rec.Code, rec.Body.String())
	}
	var resp struct {
		BindingGroup model.BindingGroup `json:"bindingGroup"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decoding create response: %v", err)
	}
	return resp.BindingGroup
}

func setNamespaces(t *testing.T, h *Handler, id uint, namespaces ...string) *httptest.ResponseRecorder {
	t.Helper()
	if namespaces == nil {
		namespaces = []string{}
	}
	return doRequest(t, h.SetBindingGroupNamespaces, http.MethodPut, "/",
		jsonBody(t, map[string]any{"namespaces": namespaces}), idParam(id))
}

func setMembers(t *testing.T, h *Handler, id uint, members []map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	if members == nil {
		members = []map[string]any{}
	}
	return doRequest(t, h.SetBindingGroupMembers, http.MethodPut, "/",
		jsonBody(t, map[string]any{"members": members}), idParam(id))
}

func bindingGroupNamespaces(t *testing.T, id uint) []model.BindingGroupNamespace {
	t.Helper()
	var rows []model.BindingGroupNamespace
	if err := model.DB.Where("project_id = ?", id).Order("namespace").Find(&rows).Error; err != nil {
		t.Fatalf("loading namespaces of group %d: %v", id, err)
	}
	return rows
}

// 重名校验按集群判定；保留中的组也占用名称，避免落到 DB 唯一索引上返回 500。
func TestCreateBindingGroupNameConflict(t *testing.T) {
	h := setupHandlerTestDB(t)
	createGroup(t, h, "c1", "admin")

	rec := doRequest(t, h.CreateBindingGroup, http.MethodPost, "/",
		jsonBody(t, map[string]any{"cluster": "c1", "name": "admin"}), nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("duplicate name in the same cluster: status %d body %s", rec.Code, rec.Body.String())
	}

	// 不同集群可以同名。
	createGroup(t, h, "c2", "admin")

	if err := model.DB.Create(&model.BindingGroup{
		Cluster: "c1", Name: "retained", Detached: true,
	}).Error; err != nil {
		t.Fatalf("seeding detached group: %v", err)
	}
	rec = doRequest(t, h.CreateBindingGroup, http.MethodPost, "/",
		jsonBody(t, map[string]any{"cluster": "c1", "name": "retained"}), nil)
	if rec.Code != http.StatusConflict {
		t.Fatalf("name used by a detached group: status %d body %s", rec.Code, rec.Body.String())
	}
}

func TestUpdateBindingGroupRenameConflict(t *testing.T) {
	h := setupHandlerTestDB(t)
	createGroup(t, h, "c1", "alpha")
	beta := createGroup(t, h, "c1", "beta")

	rec := doRequest(t, h.UpdateBindingGroup, http.MethodPut, "/",
		jsonBody(t, map[string]any{"name": "alpha"}), idParam(beta.ID))
	if rec.Code != http.StatusConflict {
		t.Fatalf("rename onto an existing name: status %d body %s", rec.Code, rec.Body.String())
	}

	rec = doRequest(t, h.UpdateBindingGroup, http.MethodPut, "/",
		jsonBody(t, map[string]any{"name": "gamma"}), idParam(beta.ID))
	if rec.Code != http.StatusOK {
		t.Fatalf("rename to a free name: status %d body %s", rec.Code, rec.Body.String())
	}
	var stored model.BindingGroup
	if err := model.DB.First(&stored, beta.ID).Error; err != nil {
		t.Fatalf("reloading group: %v", err)
	}
	if stored.Name != "gamma" {
		t.Fatalf("stored name = %q, want gamma", stored.Name)
	}
}

// 关键回归：命名空间归属的唯一性限定在集群内，不同集群的同名命名空间互不影响；
// 同集群内已被另一个组占用时拒绝（不允许静默把授权从原组搬走）。
func TestSetBindingGroupNamespacesIsScopedToCluster(t *testing.T) {
	h := setupHandlerTestDB(t)
	c1Group := createGroup(t, h, "c1", "c1-group")
	c2Group := createGroup(t, h, "c2", "c2-group")

	if rec := setNamespaces(t, h, c1Group.ID, "default"); rec.Code != http.StatusOK {
		t.Fatalf("binding c1 namespaces: status %d body %s", rec.Code, rec.Body.String())
	}
	if rec := setNamespaces(t, h, c2Group.ID, "default"); rec.Code != http.StatusOK {
		t.Fatalf("binding c2 namespaces: status %d body %s", rec.Code, rec.Body.String())
	}

	var all []model.BindingGroupNamespace
	if err := model.DB.Order("cluster").Find(&all).Error; err != nil {
		t.Fatalf("loading namespaces: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("expected both clusters to own their own 'default', got %+v", all)
	}
	for _, row := range all {
		if row.Namespace != "default" {
			t.Fatalf("unexpected namespace row %+v", row)
		}
		switch row.Cluster {
		case "c1":
			if row.ProjectID != c1Group.ID {
				t.Fatalf("c1/default owned by group %d, want %d", row.ProjectID, c1Group.ID)
			}
		case "c2":
			if row.ProjectID != c2Group.ID {
				t.Fatalf("c2/default owned by group %d, want %d", row.ProjectID, c2Group.ID)
			}
		default:
			t.Fatalf("unexpected cluster %q in %+v", row.Cluster, row)
		}
	}

	// 同集群内绑定已被占用的命名空间：拒绝，且原归属不变（需先到原组解绑）。
	third := createGroup(t, h, "c1", "c1-third")
	rec := setNamespaces(t, h, third.ID, "default")
	if rec.Code != http.StatusConflict {
		t.Fatalf("binding a namespace taken by another group: status %d body %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "binding_group_namespace_taken") {
		t.Fatalf("expected the taken-namespace code, got %s", rec.Body.String())
	}
	if rows := bindingGroupNamespaces(t, c1Group.ID); len(rows) != 1 {
		t.Fatalf("the original owner must keep the namespace, got %+v", rows)
	}
	if rows := bindingGroupNamespaces(t, third.ID); len(rows) != 0 {
		t.Fatalf("the rejected group must not own anything, got %+v", rows)
	}

	// 原组解绑后，同一个命名空间可以正常绑到新组。
	if rec := setNamespaces(t, h, c1Group.ID); rec.Code != http.StatusOK {
		t.Fatalf("releasing c1 namespace: status %d body %s", rec.Code, rec.Body.String())
	}
	if rec := setNamespaces(t, h, third.ID, "default"); rec.Code != http.StatusOK {
		t.Fatalf("binding after release: status %d body %s", rec.Code, rec.Body.String())
	}
	rows := bindingGroupNamespaces(t, third.ID)
	if len(rows) != 1 || rows[0].Cluster != "c1" || rows[0].Namespace != "default" {
		t.Fatalf("expected the new c1 owner, got %+v", rows)
	}
	// 另一个集群仍然持有自己的 default。
	if rows := bindingGroupNamespaces(t, c2Group.ID); len(rows) != 1 {
		t.Fatalf("expected c2 to keep its own default, got %+v", rows)
	}
}

func TestSetBindingGroupMembers(t *testing.T) {
	h := setupHandlerTestDB(t)
	role := model.Role{Name: "pod-reader", Resources: []string{"pods"}, Verbs: []string{"get"}}
	if err := model.DB.Create(&role).Error; err != nil {
		t.Fatalf("seeding role: %v", err)
	}
	group := createGroup(t, h, "c1", "group")

	rec := setMembers(t, h, group.ID, []map[string]any{
		{"subjectType": "user", "subject": "alice", "roleIds": []uint{role.ID, 9999}},
		{"subjectType": "group", "subject": "sre", "roleIds": []uint{role.ID}},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("setting members: status %d body %s", rec.Code, rec.Body.String())
	}

	var members []model.BindingGroupMember
	if err := model.DB.Where("project_id = ?", group.ID).Order("subject").Find(&members).Error; err != nil {
		t.Fatalf("loading members: %v", err)
	}
	if len(members) != 2 {
		t.Fatalf("expected 2 members, got %+v", members)
	}
	for _, m := range members {
		if m.RoleID != role.ID {
			t.Fatalf("expected unknown role ids to be skipped, got role %d", m.RoleID)
		}
	}
	if members[0].Subject != "alice" || members[1].Subject != "sre" {
		t.Fatalf("unexpected subjects: %+v", members)
	}

	// 全量替换：传空列表即清空。
	if rec := setMembers(t, h, group.ID, nil); rec.Code != http.StatusOK {
		t.Fatalf("clearing members: status %d body %s", rec.Code, rec.Body.String())
	}
	var count int64
	if err := model.DB.Model(&model.BindingGroupMember{}).
		Where("project_id = ?", group.ID).Count(&count).Error; err != nil {
		t.Fatalf("counting members: %v", err)
	}
	if count != 0 {
		t.Fatalf("expected members to be cleared, got %d", count)
	}
}

// 职责分离（等保三级）：权限绑定组写入同样拦住互斥的管理员角色组合。
func TestSetBindingGroupMembersRejectsRoleConflict(t *testing.T) {
	h := setupHandlerTestDB(t)

	adminRole := model.Role{Name: model.DefaultAdminRole.Name, Resources: []string{"pods"}, Verbs: []string{"get"}}
	auditRole := model.Role{Name: model.DefaultAuditorRole.Name, Grants: model.ResourceGrants{{Resource: "settings.audit", Verbs: []string{"get"}}}}
	for _, role := range []*model.Role{&adminRole, &auditRole} {
		if err := model.DB.Create(role).Error; err != nil {
			t.Fatalf("seeding role %s: %v", role.Name, err)
		}
	}
	user := model.User{Username: "alice", Provider: model.AuthProviderPassword, Enabled: true}
	if err := model.DB.Create(&user).Error; err != nil {
		t.Fatalf("seeding user: %v", err)
	}
	group := createGroup(t, h, "c1", "group")

	// 一次写入里同时授予两个互斥角色：拒绝。
	rec := setMembers(t, h, group.ID, []map[string]any{
		{"subjectType": "user", "subject": "alice", "roleIds": []uint{adminRole.ID, auditRole.ID}},
	})
	if rec.Code != http.StatusConflict {
		t.Fatalf("conflicting member roles: status %d body %s", rec.Code, rec.Body.String())
	}
	var body struct {
		Code    string   `json:"code"`
		Subject string   `json:"subject"`
		Roles   []string `json:"roles"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decoding conflict response: %v", err)
	}
	if body.Code != "role_conflict" || body.Subject != "alice" || len(body.Roles) != 2 {
		t.Fatalf("unexpected conflict response: %+v", body)
	}
	// 被拒绝的写入不能留下一半成员。
	var count int64
	if err := model.DB.Model(&model.BindingGroupMember{}).
		Where("project_id = ?", group.ID).Count(&count).Error; err != nil {
		t.Fatalf("counting members: %v", err)
	}
	if count != 0 {
		t.Fatalf("rejected writes must not persist members, got %d", count)
	}

	// 只授予其中一个角色：放行。
	if rec := setMembers(t, h, group.ID, []map[string]any{
		{"subjectType": "user", "subject": "alice", "roleIds": []uint{auditRole.ID}},
	}); rec.Code != http.StatusOK {
		t.Fatalf("single role: status %d body %s", rec.Code, rec.Body.String())
	}

	// 用户组主体不做写入侧判定（成员关系由目录侧维护），仍然放行。
	if rec := setMembers(t, h, group.ID, []map[string]any{
		{"subjectType": "group", "subject": "sre", "roleIds": []uint{adminRole.ID, auditRole.ID}},
	}); rec.Code != http.StatusOK {
		t.Fatalf("group subject: status %d body %s", rec.Code, rec.Body.String())
	}
}

func TestDeleteBindingGroupRemovesNamespacesAndMembers(t *testing.T) {
	h := setupHandlerTestDB(t)
	role := model.Role{Name: "pod-reader", Resources: []string{"pods"}, Verbs: []string{"get"}}
	if err := model.DB.Create(&role).Error; err != nil {
		t.Fatalf("seeding role: %v", err)
	}
	group := createGroup(t, h, "c1", "group")
	if rec := setNamespaces(t, h, group.ID, "dev"); rec.Code != http.StatusOK {
		t.Fatalf("binding namespaces: status %d body %s", rec.Code, rec.Body.String())
	}
	if rec := setMembers(t, h, group.ID, []map[string]any{
		{"subjectType": "user", "subject": "alice", "roleIds": []uint{role.ID}},
	}); rec.Code != http.StatusOK {
		t.Fatalf("setting members: status %d body %s", rec.Code, rec.Body.String())
	}

	rec := doRequest(t, h.DeleteBindingGroup, http.MethodDelete, "/", "", idParam(group.ID))
	if rec.Code != http.StatusOK {
		t.Fatalf("deleting group: status %d body %s", rec.Code, rec.Body.String())
	}

	var groups int64
	if err := model.DB.Model(&model.BindingGroup{}).Count(&groups).Error; err != nil {
		t.Fatalf("counting groups: %v", err)
	}
	var namespaces int64
	if err := model.DB.Model(&model.BindingGroupNamespace{}).Count(&namespaces).Error; err != nil {
		t.Fatalf("counting namespaces: %v", err)
	}
	var members int64
	if err := model.DB.Model(&model.BindingGroupMember{}).Count(&members).Error; err != nil {
		t.Fatalf("counting members: %v", err)
	}
	if groups != 0 || namespaces != 0 || members != 0 {
		t.Fatalf("expected an empty database, got groups=%d namespaces=%d members=%d",
			groups, namespaces, members)
	}
}

func TestListBindingGroupsReturnsSavedData(t *testing.T) {
	h := setupHandlerTestDB(t)
	role := model.Role{Name: "pod-reader", Resources: []string{"pods"}, Verbs: []string{"get"}}
	if err := model.DB.Create(&role).Error; err != nil {
		t.Fatalf("seeding role: %v", err)
	}
	group := createGroup(t, h, "c1", "group")
	if rec := setNamespaces(t, h, group.ID, "dev", "prod"); rec.Code != http.StatusOK {
		t.Fatalf("binding namespaces: status %d body %s", rec.Code, rec.Body.String())
	}
	if rec := setMembers(t, h, group.ID, []map[string]any{
		{"subjectType": "user", "subject": "alice", "roleIds": []uint{role.ID}},
	}); rec.Code != http.StatusOK {
		t.Fatalf("setting members: status %d body %s", rec.Code, rec.Body.String())
	}

	rec := doRequest(t, h.ListBindingGroups, http.MethodGet, "/?cluster=c1", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: status %d body %s", rec.Code, rec.Body.String())
	}
	var resp struct {
		BindingGroups []model.BindingGroup `json:"bindingGroups"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decoding list response: %v", err)
	}
	if len(resp.BindingGroups) != 1 {
		t.Fatalf("expected 1 group, got %+v", resp.BindingGroups)
	}

	saved := resp.BindingGroups[0]
	names := make([]string, 0, len(saved.Namespaces))
	for _, ns := range saved.Namespaces {
		names = append(names, ns.Namespace)
	}
	sort.Strings(names)
	if len(names) != 2 || names[0] != "dev" || names[1] != "prod" {
		t.Fatalf("expected the list to return the saved namespaces, got %+v", names)
	}
	if len(saved.Members) != 1 || saved.Members[0].Subject != "alice" {
		t.Fatalf("expected the list to return the saved members, got %+v", saved.Members)
	}
	if saved.Members[0].Role.Name != role.Name {
		t.Fatalf("expected the member role to be preloaded, got %+v", saved.Members[0].Role)
	}
}

// 锁定前端依赖的 JSON 契约：字段名必须是小写驼峰，否则列表页读不到数据。
func TestListBindingGroupsJSONContract(t *testing.T) {
	h := setupHandlerTestDB(t)
	role := model.Role{Name: "pod-reader", Resources: []string{"pods"}, Verbs: []string{"get"}}
	if err := model.DB.Create(&role).Error; err != nil {
		t.Fatalf("seeding role: %v", err)
	}
	group := createGroup(t, h, "c1", "group")
	if rec := setNamespaces(t, h, group.ID, "dev"); rec.Code != http.StatusOK {
		t.Fatalf("binding namespaces: %d %s", rec.Code, rec.Body.String())
	}
	if rec := setMembers(t, h, group.ID, []map[string]any{
		{"subjectType": "user", "subject": "alice", "roleIds": []uint{role.ID}},
	}); rec.Code != http.StatusOK {
		t.Fatalf("setting members: %d %s", rec.Code, rec.Body.String())
	}

	rec := doRequest(t, h.ListBindingGroups, http.MethodGet, "/?cluster=c1", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	var resp map[string][]map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decoding list response: %v", err)
	}
	groups := resp["bindingGroups"]
	if len(groups) != 1 {
		t.Fatalf("expected 1 group, got %+v", groups)
	}
	got := groups[0]

	for _, key := range []string{"id", "cluster", "name", "description", "detached", "namespaces", "members"} {
		if _, ok := got[key]; !ok {
			t.Fatalf("missing expected JSON key %q in %v", key, got)
		}
	}
	if got["name"] != "group" || got["cluster"] != "c1" {
		t.Fatalf("unexpected name/cluster values: %+v", got)
	}

	namespaces, _ := got["namespaces"].([]any)
	if len(namespaces) != 1 {
		t.Fatalf("expected 1 namespace, got %+v", namespaces)
	}
	nsEntry, _ := namespaces[0].(map[string]any)
	for _, key := range []string{"namespace", "cluster", "projectId"} {
		if _, ok := nsEntry[key]; !ok {
			t.Fatalf("missing expected namespace JSON key %q in %v", key, nsEntry)
		}
	}
	if nsEntry["namespace"] != "dev" {
		t.Fatalf("unexpected namespace value: %+v", nsEntry)
	}

	members, _ := got["members"].([]any)
	if len(members) != 1 {
		t.Fatalf("expected 1 member, got %+v", members)
	}
	memberEntry, _ := members[0].(map[string]any)
	for _, key := range []string{"subjectType", "subject", "roleId", "role", "projectId"} {
		if _, ok := memberEntry[key]; !ok {
			t.Fatalf("missing expected member JSON key %q in %v", key, memberEntry)
		}
	}
	if memberEntry["subject"] != "alice" || memberEntry["subjectType"] != "user" {
		t.Fatalf("unexpected subject values: %+v", memberEntry)
	}
	if memberRole, ok := memberEntry["role"].(map[string]any); !ok || memberRole["name"] != role.Name {
		t.Fatalf("expected the member role to be preloaded, got %+v", memberEntry["role"])
	}
}

func TestListBindingGroupsFiltersClusterAndDetached(t *testing.T) {
	h := setupHandlerTestDB(t)
	createGroup(t, h, "c1", "c1-live")
	createGroup(t, h, "c2", "c2-live")
	if err := model.DB.Create(&model.BindingGroup{
		Cluster: "c1", Name: "c1-retained", Detached: true,
	}).Error; err != nil {
		t.Fatalf("seeding detached group: %v", err)
	}

	decode := func(rec *httptest.ResponseRecorder) []model.BindingGroup {
		t.Helper()
		if rec.Code != http.StatusOK {
			t.Fatalf("list: status %d body %s", rec.Code, rec.Body.String())
		}
		var resp struct {
			BindingGroups []model.BindingGroup `json:"bindingGroups"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decoding list response: %v", err)
		}
		return resp.BindingGroups
	}

	groups := decode(doRequest(t, h.ListBindingGroups, http.MethodGet, "/?cluster=c1", "", nil))
	if len(groups) != 1 || groups[0].Name != "c1-live" {
		t.Fatalf("expected only the live c1 group, got %+v", groups)
	}

	groups = decode(doRequest(t, h.ListBindingGroups, http.MethodGet, "/?detached=true", "", nil))
	if len(groups) != 1 || groups[0].Name != "c1-retained" {
		t.Fatalf("expected only the detached group, got %+v", groups)
	}
}

// 删除权限绑定的审计记录必须带组名与快照：成员与命名空间随组一起删掉，
// 只有快照能还原「谁在哪些命名空间上拿到过哪些角色」。
func TestDeleteBindingGroupRecordsAuditDetail(t *testing.T) {
	h := setupHandlerTestDB(t)
	role := model.Role{Name: "pod-reader", Resources: []string{"pods"}, Verbs: []string{"get"}}
	if err := model.DB.Create(&role).Error; err != nil {
		t.Fatalf("seeding role: %v", err)
	}
	group := createGroup(t, h, "c1", "group")
	if rec := setMembers(t, h, group.ID, []map[string]any{
		{"subjectType": "user", "subject": "alice", "roleIds": []uint{role.ID}},
	}); rec.Code != http.StatusOK {
		t.Fatalf("setting members: status %d body %s", rec.Code, rec.Body.String())
	}

	var detail common.AdminAuditDetail
	router := gin.New()
	router.DELETE("/:id", func(c *gin.Context) {
		h.DeleteBindingGroup(c)
		if value, ok := c.Get(common.AdminAuditDetailKey); ok {
			detail, _ = value.(common.AdminAuditDetail)
		}
	})

	request := httptest.NewRequest(http.MethodDelete, "/"+strconv.FormatUint(uint64(group.ID), 10), nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("deleting group: status %d body %s", response.Code, response.Body.String())
	}
	if detail.ResourceName != "group" {
		t.Fatalf("audit resourceName = %q, want the group name", detail.ResourceName)
	}
	if !strings.Contains(detail.PreviousYAML, "subject: alice") {
		t.Fatalf("audit snapshot must include the member grant, got %q", detail.PreviousYAML)
	}
}
