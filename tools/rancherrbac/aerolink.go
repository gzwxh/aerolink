package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/zxh326/kite/pkg/common"
)

// 本文件是鸢联 AeroLink 管理接口的薄封装。迁移只用这几个接口：
// 角色（/api/v1/admin/roles）、权限绑定组（/api/v1/admin/binding-groups）与用户列表。
// 鉴权用 AeroLink 的 API key：请求头 Authorization 直接放控制台里那串 aerolink<id>-<secret>
// （改名前的 kite<id>-<secret> 同样接受）。
type aerolinkClient struct {
	*httpClient
}

func newAeroLinkClient(base, token string, insecure bool, timeout time.Duration, verbose bool) *aerolinkClient {
	headers := map[string]string{"Authorization": token}
	return &aerolinkClient{newHTTPClient(base, headers, insecure, timeout, verbose, "")}
}

type aerolinkCluster struct {
	ID   uint   `json:"id"`
	Name string `json:"name"`
}

type aerolinkRole struct {
	ID          uint                   `json:"id"`
	Name        string                 `json:"name"`
	DisplayName string                 `json:"displayName"`
	Description string                 `json:"description"`
	IsSystem    bool                   `json:"isSystem"`
	Grants      []common.ResourceGrant `json:"grants"`
	Resources   []string               `json:"resources"`
	Verbs       []string               `json:"verbs"`
}

type aerolinkNamespaceRef struct {
	Namespace string `json:"namespace"`
}

type aerolinkBindingGroup struct {
	ID          uint                   `json:"id"`
	Cluster     string                 `json:"cluster"`
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	Global      bool                   `json:"global"`
	Detached    bool                   `json:"detached"`
	Protected   bool                   `json:"protected"`
	Namespaces  []aerolinkNamespaceRef `json:"namespaces"`
}

type aerolinkMember struct {
	SubjectType string       `json:"subjectType"`
	Subject     string       `json:"subject"`
	Namespace   string       `json:"namespace"`
	RoleID      uint         `json:"roleId"`
	Protected   bool         `json:"protected"`
	Role        aerolinkRole `json:"role"`
}

type aerolinkMemberInput struct {
	SubjectType string `json:"subjectType"`
	Subject     string `json:"subject"`
	Namespace   string `json:"namespace"`
	RoleIDs     []uint `json:"roleIds"`
}

func (c *aerolinkClient) clusters() ([]aerolinkCluster, error) {
	var clusters []aerolinkCluster
	if err := c.getJSON("/api/v1/admin/clusters/", &clusters); err != nil {
		return nil, err
	}
	sort.Slice(clusters, func(i, j int) bool { return clusters[i].Name < clusters[j].Name })
	return clusters, nil
}

func (c *aerolinkClient) roles() ([]aerolinkRole, error) {
	var doc struct {
		Roles []aerolinkRole `json:"roles"`
	}
	if err := c.getJSON("/api/v1/admin/roles/", &doc); err != nil {
		return nil, err
	}
	return doc.Roles, nil
}

func (c *aerolinkClient) createRole(mapping roleMapping) (aerolinkRole, error) {
	body := map[string]any{
		"name":        mapping.Name,
		"displayName": mapping.DisplayName,
		"description": mapping.Description,
		"grants":      mapping.Grants,
	}
	payload, err := c.do(http.MethodPost, "/api/v1/admin/roles/", body)
	if err != nil {
		return aerolinkRole{}, err
	}
	var doc struct {
		Role aerolinkRole `json:"role"`
	}
	if err := json.Unmarshal(payload, &doc); err != nil {
		return aerolinkRole{}, fmt.Errorf("decode created role: %w", err)
	}
	return doc.Role, nil
}

func (c *aerolinkClient) updateRole(id uint, mapping roleMapping) error {
	body := map[string]any{
		"name":        mapping.Name,
		"displayName": mapping.DisplayName,
		"description": mapping.Description,
		"grants":      mapping.Grants,
	}
	_, err := c.do(http.MethodPut, fmt.Sprintf("/api/v1/admin/roles/%d", id), body)
	return err
}

func (c *aerolinkClient) bindingGroups() ([]aerolinkBindingGroup, error) {
	var doc struct {
		BindingGroups []aerolinkBindingGroup `json:"bindingGroups"`
	}
	if err := c.getJSON("/api/v1/admin/binding-groups/", &doc); err != nil {
		return nil, err
	}
	return doc.BindingGroups, nil
}

func (c *aerolinkClient) createBindingGroup(cluster, name, description string) (aerolinkBindingGroup, error) {
	body := map[string]any{"cluster": cluster, "name": name, "description": description}
	payload, err := c.do(http.MethodPost, "/api/v1/admin/binding-groups/", body)
	if err != nil {
		return aerolinkBindingGroup{}, err
	}
	var doc struct {
		BindingGroup aerolinkBindingGroup `json:"bindingGroup"`
	}
	if err := json.Unmarshal(payload, &doc); err != nil {
		return aerolinkBindingGroup{}, fmt.Errorf("decode created binding group: %w", err)
	}
	return doc.BindingGroup, nil
}

func (c *aerolinkClient) setBindingGroupNamespaces(id uint, namespaces []string) error {
	sorted := append([]string(nil), namespaces...)
	sort.Strings(sorted)
	body := map[string]any{"namespaces": sorted}
	_, err := c.do(http.MethodPut, fmt.Sprintf("/api/v1/admin/binding-groups/%d/namespaces", id), body)
	return err
}

func (c *aerolinkClient) bindingGroupMembers(id uint) ([]aerolinkMember, error) {
	var doc struct {
		Members []aerolinkMember `json:"members"`
	}
	if err := c.getJSON(fmt.Sprintf("/api/v1/admin/binding-groups/%d/members", id), &doc); err != nil {
		return nil, err
	}
	return doc.Members, nil
}

func (c *aerolinkClient) setBindingGroupMembers(id uint, members []aerolinkMemberInput) error {
	sort.Slice(members, func(i, j int) bool {
		if members[i].SubjectType != members[j].SubjectType {
			return members[i].SubjectType < members[j].SubjectType
		}
		if members[i].Subject != members[j].Subject {
			return members[i].Subject < members[j].Subject
		}
		return members[i].Namespace < members[j].Namespace
	})
	body := map[string]any{"members": members}
	_, err := c.do(http.MethodPut, fmt.Sprintf("/api/v1/admin/binding-groups/%d/members", id), body)
	return err
}

// usernames 返回鸢联 AeroLink 已知的全部用户名，用于提示「绑定已写入、但账号还没被鸢联 AeroLink 见过」。
func (c *aerolinkClient) usernames() (map[string]struct{}, error) {
	known := map[string]struct{}{}
	for page := 1; page <= 200; page++ {
		var doc struct {
			Users []struct {
				Username string `json:"username"`
			} `json:"users"`
			Total int `json:"total"`
		}
		path := fmt.Sprintf("/api/v1/admin/users/?page=%d&size=200", page)
		if err := c.getJSON(path, &doc); err != nil {
			return nil, err
		}
		for _, user := range doc.Users {
			if strings.TrimSpace(user.Username) != "" {
				known[user.Username] = struct{}{}
			}
		}
		if len(known) >= doc.Total || len(doc.Users) == 0 {
			break
		}
	}
	return known, nil
}

func (c *aerolinkClient) deleteRole(id uint) error {
	_, err := c.do(http.MethodDelete, fmt.Sprintf("/api/v1/admin/roles/%d", id), nil)
	return err
}

func (c *aerolinkClient) deleteBindingGroup(id uint) error {
	_, err := c.do(http.MethodDelete, fmt.Sprintf("/api/v1/admin/binding-groups/%d", id), nil)
	return err
}

// explainAuthError 把鸢联 AeroLink 侧的鉴权失败翻成可操作的提示：
// 401 是 token 不对，403 是没有 settings.rbac 的写权限（或该章节由配置文件托管），
// 或者账号开了 MFA 二次校验（删除类操作会被拦）。
func explainAuthError(err error) error {
	var statusError *httpStatusError
	if !errors.As(err, &statusError) {
		return err
	}
	hint := ""
	switch {
	case statusError.Status == http.StatusUnauthorized:
		hint = "：AeroLink API key 无效或已停用。请求头里的值应当是控制台创建时给出的那份完整 API key（形如 aerolink1-xxxxxxxx；改名前的 kite1-xxxxxxxx 仍可用）"
	case strings.Contains(statusError.Body, "mfa_verification_required"):
		hint = "：该账号开启了 MFA 二次校验，API key 无法完成校验。请换一个未强制 MFA 的管理员账号生成 API key"
	case statusError.Status == http.StatusForbidden:
		hint = "：该 API key 没有「角色与权限绑定」章节（settings.rbac）的写权限，或该章节由配置文件托管、控制台下发了只读"
	}
	if hint == "" {
		return err
	}
	return fmt.Errorf("%w%s", err, hint)
}

// aerolinkURLJoin 便于在报告里输出可点击的地址。
func aerolinkURLJoin(base, path string) string {
	joined, err := url.JoinPath(base, path)
	if err != nil {
		return base + path
	}
	return joined
}
