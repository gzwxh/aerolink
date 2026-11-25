package rbac

import (
	"testing"

	"aerolink/pkg/common"
	"aerolink/pkg/model"
)

// systemRoleSet 把内置系统角色转成判定用的形态（与 DB 同步后 RBACConfig 里的内容一致）。
func systemRoleSet() map[string]common.Role {
	roles := make(map[string]common.Role)
	for _, role := range model.SystemRoles() {
		roles[role.Name] = commonRole(role)
	}
	return roles
}

// userWithSystemRoles 构造一个直接持有若干内置角色的用户。
func userWithSystemRoles(names ...string) model.User {
	all := systemRoleSet()
	held := make([]common.Role, 0, len(names))
	for _, name := range names {
		if role, ok := all[name]; ok {
			held = append(held, role)
		}
	}
	return model.User{Username: "alice", Roles: held}
}

// 控制台设置族资源必须显式授权：通配 * 不覆盖，否则一个含 * 的普通角色就能把
// 「系统配置 / 安全授权 / 审计」三员的权限并回一人，职责分离失效。
func TestSettingsFamilyRequiresExplicitGrant(t *testing.T) {
	wildcard := common.Role{Name: "wildcard", Resources: []string{"*"}, Verbs: []string{"*"}}
	for _, resource := range []string{
		common.SystemSettingsResource,
		common.SettingsSectionResource(common.SettingsSectionAudit),
		common.SettingsSectionResource(common.SettingsSectionUsers),
	} {
		if roleAllows(wildcard, resource, string(common.VerbGet)) {
			t.Fatalf("wildcard role must not cover %s", resource)
		}
	}
	// 但通配仍然覆盖普通资源。
	if !roleAllows(wildcard, "pods", string(common.VerbGet)) {
		t.Fatal("wildcard role should still cover ordinary resources")
	}
}

// 父级 settings 覆盖全部章节；章节规则不反过来覆盖父级。
func TestSettingsParentCoversEverySection(t *testing.T) {
	parent := common.Role{Name: "parent", Resources: []string{common.SystemSettingsResource}, Verbs: []string{"*"}}
	for _, section := range common.SettingsSections {
		if !roleAllows(parent, common.SettingsSectionResource(section), string(common.VerbGet)) {
			t.Fatalf("settings parent rule should cover section %s", section)
		}
	}
	if !roleAllows(parent, common.SystemSettingsResource, string(common.VerbGet)) {
		t.Fatal("settings parent rule should cover the parent itself")
	}

	section := common.Role{
		Name:   "section-only",
		Grants: []common.ResourceGrant{{Resource: common.SettingsSectionResource(common.SettingsSectionAudit), Verbs: []string{"get"}}},
	}
	if !roleAllows(section, common.SettingsSectionResource(common.SettingsSectionAudit), string(common.VerbGet)) {
		t.Fatal("section grant should cover its own section")
	}
	if roleAllows(section, common.SystemSettingsResource, string(common.VerbGet)) {
		t.Fatal("a section grant must not cover the parent resource")
	}
}

// 内置三员角色的实际权限集互不相交：谁都进不了别人的章节。
//
// 只读管理员不在三员之列（它的章节权限见 TestViewerReadsEverySettingsSection）。
func TestBuiltinRolesAreSeparated(t *testing.T) {
	admin := commonRole(model.DefaultAdminRole)
	securityAdmin := commonRole(model.DefaultSecurityAdminRole)
	auditor := commonRole(model.DefaultAuditorRole)

	section := common.SettingsSectionResource

	cases := []struct {
		name  string
		role  common.Role
		allow []string
		deny  []string
	}{
		{
			name: "系统管理员",
			role: admin,
			allow: []string{
				section(common.SettingsSectionGeneral),
				section(common.SettingsSectionClusters),
				section(common.SettingsSectionNotification),
				section(common.SettingsSectionTemplates),
				section(common.SettingsSectionAPIKeys),
				section(common.SettingsSectionUsers),
				section(common.SettingsSectionRBAC),
				section(common.SettingsSectionSecurity),
				section(common.SettingsSectionAuthentication),
				section(common.SettingsSectionAudit),
			},
			deny: nil,
		},
		{
			name: "安全管理员",
			role: securityAdmin,
			allow: []string{
				section(common.SettingsSectionUsers),
				section(common.SettingsSectionRBAC),
				section(common.SettingsSectionSecurity),
				section(common.SettingsSectionAuthentication),
			},
			deny: []string{
				section(common.SettingsSectionGeneral),
				section(common.SettingsSectionClusters),
				section(common.SettingsSectionNotification),
				section(common.SettingsSectionTemplates),
				section(common.SettingsSectionAPIKeys),
				section(common.SettingsSectionAudit),
			},
		},
		{
			name:  "审计管理员",
			role:  auditor,
			allow: []string{section(common.SettingsSectionAudit)},
			deny: []string{
				section(common.SettingsSectionGeneral),
				section(common.SettingsSectionClusters),
				section(common.SettingsSectionUsers),
				section(common.SettingsSectionRBAC),
				section(common.SettingsSectionSecurity),
				section(common.SettingsSectionAuthentication),
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, resource := range tc.allow {
				if !roleAllows(tc.role, resource, string(common.VerbGet)) {
					t.Fatalf("%s should be allowed to read %s", tc.name, resource)
				}
			}
			for _, resource := range tc.deny {
				if roleAllows(tc.role, resource, string(common.VerbGet)) {
					t.Fatalf("%s must not read %s", tc.name, resource)
				}
			}
		})
	}
}

// 审计管理员不再像旧定义那样「全资源只读」：它拿不到 secrets 与业务资源。
func TestAuditorHasNoClusterResourceAccess(t *testing.T) {
	auditor := commonRole(model.DefaultAuditorRole)
	for _, resource := range []string{"secrets", "pods", "deployments", "nodes"} {
		if roleAllows(auditor, resource, string(common.VerbGet)) {
			t.Fatalf("audit administrator must not read %s", resource)
		}
	}
}

// 只读管理员被排除了 secrets。
func TestViewerExcludesSecrets(t *testing.T) {
	viewer := commonRole(model.DefaultViewerRole)
	if !roleAllows(viewer, "pods", string(common.VerbGet)) {
		t.Fatal("read-only administrator should read pods")
	}
	if roleAllows(viewer, "secrets", string(common.VerbGet)) {
		t.Fatal("read-only administrator must not read secrets")
	}
}

// 只读管理员不是三员之一：它能只读打开每个设置章节（父级 settings + get），
// 但没有任何章节的 update，所以只看得到、改不了。
func TestViewerReadsEverySettingsSection(t *testing.T) {
	viewer := commonRole(model.DefaultViewerRole)
	if !roleAllows(viewer, common.SystemSettingsResource, string(common.VerbGet)) {
		t.Fatal("read-only administrator should read the settings parent resource")
	}
	for _, name := range common.SettingsSections {
		resource := common.SettingsSectionResource(name)
		if !roleAllows(viewer, resource, string(common.VerbGet)) {
			t.Fatalf("read-only administrator should read section %s", name)
		}
		if roleAllows(viewer, resource, string(common.SystemSettingsVerb)) {
			t.Fatalf("read-only administrator must not manage section %s", name)
		}
	}
}

// 合并后的系统管理员是唯一的最高权限角色：Kubernetes 授权对象也能管（不再靠排除规则收窄）。
func TestSystemAdminIsUnrestricted(t *testing.T) {
	admin := commonRole(model.DefaultAdminRole)
	for _, resource := range []string{"roles", "rolebindings", "clusterroles", "clusterrolebindings", "serviceaccounts", "deployments", "secrets"} {
		if !roleAllows(admin, resource, string(common.VerbCreate)) {
			t.Fatalf("the merged administrator role must manage %s", resource)
		}
	}
}

// 最高权限角色必须能管理全部设置章节，否则控制台会没人能管设置与权限。
func TestAdminRoleKeepsEverySettingsSection(t *testing.T) {
	admin := commonRole(model.DefaultAdminRole)
	for _, section := range common.SettingsSections {
		if !roleAllows(admin, common.SettingsSectionResource(section), string(common.SystemSettingsVerb)) {
			t.Fatalf("the administrator role must manage section %s", section)
		}
	}
}

// 三员准入：任一设置章节权限即可进入管理接口（这是审计/安全管理员不再需要
// admin 角色名的关键）；只读管理员能读全部章节，因此也能进入（接口按动词再判一次，
// 它只拿得到 GET）；无角色用户进不去。
func TestCanAccessAdminAPIForBuiltinRoles(t *testing.T) {
	cases := []struct {
		name  string
		roles []string
		want  bool
	}{
		{"系统管理员", []string{model.DefaultAdminRole.Name}, true},
		{"安全管理员", []string{model.DefaultSecurityAdminRole.Name}, true},
		{"审计管理员", []string{model.DefaultAuditorRole.Name}, true},
		{"只读管理员", []string{model.DefaultViewerRole.Name}, true},
		{"无角色", nil, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			user := userWithSystemRoles(tc.roles...)
			if got := CanAccessAdminAPI(user); got != tc.want {
				t.Fatalf("CanAccessAdminAPI = %v, want %v", got, tc.want)
			}
		})
	}
}

// 职责分离：三员角色不得由同一账号兼任；只读管理员和超级角色不参与互斥。
func TestSeparationOfDutiesConflict(t *testing.T) {
	cases := []struct {
		name         string
		roles        []string
		wantConflict bool
	}{
		{"只持系统管理员", []string{model.DefaultAdminRole.Name}, false},
		{"只持安全管理员", []string{model.DefaultSecurityAdminRole.Name}, false},
		{"只持审计管理员", []string{model.DefaultAuditorRole.Name}, false},
		{"系统管理员 + 安全管理员", []string{model.DefaultAdminRole.Name, model.DefaultSecurityAdminRole.Name}, true},
		{"系统管理员 + 审计管理员", []string{model.DefaultAdminRole.Name, model.DefaultAuditorRole.Name}, true},
		{"安全管理员 + 审计管理员", []string{model.DefaultSecurityAdminRole.Name, model.DefaultAuditorRole.Name}, true},
		{"三员兼任", []string{
			model.DefaultAdminRole.Name,
			model.DefaultSecurityAdminRole.Name,
			model.DefaultAuditorRole.Name,
		}, true},
		{"系统管理员 + 只读管理员", []string{model.DefaultAdminRole.Name, model.DefaultViewerRole.Name}, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			user := userWithSystemRoles(tc.roles...)
			conflict, roles := SeparationOfDutiesConflict(user)
			if conflict != tc.wantConflict {
				t.Fatalf("SeparationOfDutiesConflict = %v (%v), want %v", conflict, roles, tc.wantConflict)
			}
			if !conflict {
				return
			}
			if len(roles) < 2 {
				t.Fatalf("conflicting roles should list at least two roles, got %v", roles)
			}
			// 冲突账号的管理面必须整体关闭（否则当事人还能继续操作权限）。
			if CanAccessAdminAPI(user) {
				t.Fatal("an account holding mutually exclusive roles must not reach the admin API")
			}
			for _, section := range common.SettingsSections {
				if CanViewSettingsSection(user, section) {
					t.Fatalf("conflicting account must not view section %s", section)
				}
			}
		})
	}
}

// 写入侧的前置校验：把互斥角色加给已持有对角色的用户应当被识别出来。
func TestSeparationOfDutiesConflictWith(t *testing.T) {
	user := userWithSystemRoles(model.DefaultAdminRole.Name)

	if conflict, _ := SeparationOfDutiesConflictWith(user, model.DefaultSecurityAdminRole.Name); !conflict {
		t.Fatal("granting the security administrator role to a system administrator must conflict")
	}
	if conflict, _ := SeparationOfDutiesConflictWith(user, model.DefaultAuditorRole.Name); !conflict {
		t.Fatal("granting the audit administrator role to a system administrator must conflict")
	}
	if conflict, roles := SeparationOfDutiesConflictWith(user, model.DefaultViewerRole.Name); conflict {
		t.Fatalf("granting the read-only administrator role must not conflict, got %v", roles)
	}
	// 重复授予同一角色不算冲突。
	if conflict, _ := SeparationOfDutiesConflictWith(user, model.DefaultAdminRole.Name); conflict {
		t.Fatal("re-granting the same role must not conflict")
	}
}
