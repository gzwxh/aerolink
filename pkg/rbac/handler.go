package rbac

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"gorm.io/gorm"
)

type roleReq struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	RoleType    string   `json:"roleType"`
	Clusters    []string `json:"clusters"`
	Namespaces  []string `json:"namespaces"`
	Resources   []string `json:"resources"`
	Verbs       []string `json:"verbs"`
}

func normalizeRoleType(roleType string) string {
	if strings.EqualFold(strings.TrimSpace(roleType), "group") {
		return "group"
	}
	return "user"
}

func (req roleReq) toRole() model.Role {
	return model.Role{
		Name:        strings.TrimSpace(req.Name),
		Description: req.Description,
		RoleType:    normalizeRoleType(req.RoleType),
		Clusters:    model.SliceString(req.Clusters),
		Namespaces:  model.SliceString(req.Namespaces),
		Resources:   model.SliceString(req.Resources),
		Verbs:       model.SliceString(req.Verbs),
	}
}

// ListRoles returns all roles with assignments
func ListRoles(c *gin.Context) {
	var roles []model.Role
	if err := model.DB.Preload("Assignments").Find(&roles).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list roles: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"roles": roles})
}

// ListGroups returns every group name currently known (LDAP/OIDC synced,
// manually assigned, or explicitly persisted) for the role-assignment picker.
func ListGroups(c *gin.Context) {
	groups, err := model.ListKnownGroups()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list groups: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"groups": groups})
}

// ListGroupMembers returns the members of a group from the normalized
// group_members table.
func ListGroupMembers(c *gin.Context) {
	name := c.Param("name")
	members, err := model.ListGroupMembers(name)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list group members: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"members": members})
}

// CreateGroup persists a user group as an entity so it stays visible even
// before it gains members or role grants.
func CreateGroup(c *gin.Context) {
	var req struct {
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "group name is required"})
		return
	}
	exists, err := model.LocalGroupExists(name)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create group: " + err.Error()})
		return
	}
	if exists {
		c.JSON(http.StatusConflict, gin.H{"error": "group already exists"})
		return
	}
	if err := model.CreateLocalGroup(name); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create group: " + err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"name": name})
}

// RenameGroup renames a persisted group and every reference to it (user
// profiles and role assignments) atomically.
func RenameGroup(c *gin.Context) {
	name := c.Param("name")
	var req struct {
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	newName := strings.TrimSpace(req.Name)
	if newName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "group name is required"})
		return
	}
	if newName == name {
		c.JSON(http.StatusOK, gin.H{"name": newName})
		return
	}
	if err := model.RenameLocalGroup(name, newName); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "group not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to rename group: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"name": newName})
}

// DeleteGroup removes a persisted group along with all its references
// (memberships on user profiles and group-subject role assignments).
func DeleteGroup(c *gin.Context) {
	name := c.Param("name")
	if err := model.DeleteLocalGroup(name); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "group not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete group: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// GetRole returns a single role by id
func GetRole(c *gin.Context) {
	id := c.Param("id")
	dbID, err := strconv.ParseUint(id, 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid role id"})
		return
	}
	var role model.Role
	if err := model.DB.Preload("Assignments").First(&role, uint(dbID)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "role not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"role": role})
}

// CreateRole creates a new role
func CreateRole(c *gin.Context) {
	if common.IsSectionManaged("rbac") {
		c.JSON(http.StatusForbidden, gin.H{"error": common.ManagedSectionError})
		return
	}

	var req roleReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	role := req.toRole()
	if role.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "role name is required"})
		return
	}
	if err := model.DB.Create(&role).Error; err != nil {
		if model.IsUniqueConstraintError(err) {
			c.JSON(http.StatusConflict, gin.H{
				"error": fmt.Sprintf("a role named %q already exists", role.Name),
				"code":  "role_name_conflict",
			})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create role: " + err.Error()})
		return
	}
	// refresh in-memory config
	TriggerSync()
	c.JSON(http.StatusCreated, gin.H{"role": role})
}

// UpdateRole updates an existing role
func UpdateRole(c *gin.Context) {
	if common.IsSectionManaged("rbac") {
		c.JSON(http.StatusForbidden, gin.H{"error": common.ManagedSectionError})
		return
	}

	id := c.Param("id")
	dbID, err := strconv.ParseUint(id, 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid role id"})
		return
	}
	var req roleReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var role model.Role
	if err := model.DB.First(&role, uint(dbID)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "role not found"})
		return
	}
	if role.IsSystem {
		c.JSON(http.StatusForbidden, gin.H{"error": "system roles cannot be modified"})
		return
	}
	roleData := req.toRole()
	if roleData.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "role name is required"})
		return
	}
	// update fields
	role.Name = roleData.Name
	role.Description = roleData.Description
	role.RoleType = roleData.RoleType
	role.Clusters = roleData.Clusters
	role.Namespaces = roleData.Namespaces
	role.Resources = roleData.Resources
	role.Verbs = roleData.Verbs

	if err := model.DB.Save(&role).Error; err != nil {
		if model.IsUniqueConstraintError(err) {
			c.JSON(http.StatusConflict, gin.H{
				"error": fmt.Sprintf("a role named %q already exists", role.Name),
				"code":  "role_name_conflict",
			})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update role: " + err.Error()})
		return
	}
	TriggerSync()
	c.JSON(http.StatusOK, gin.H{"role": role})
}

// DeleteRole deletes a role and its assignments
func DeleteRole(c *gin.Context) {
	if common.IsSectionManaged("rbac") {
		c.JSON(http.StatusForbidden, gin.H{"error": common.ManagedSectionError})
		return
	}

	id := c.Param("id")
	dbID, err := strconv.ParseUint(id, 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid role id"})
		return
	}
	var role model.Role
	if err := model.DB.First(&role, uint(dbID)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "role not found"})
		return
	}
	if role.IsSystem {
		c.JSON(http.StatusForbidden, gin.H{"error": "system roles cannot be deleted"})
		return
	}
	if err := model.DB.Delete(&role).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete role: " + err.Error()})
		return
	}
	TriggerSync()
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// Assignment APIs
type roleAssignmentReq struct {
	SubjectType string `json:"subjectType" binding:"required"`
	Subject     string `json:"subject" binding:"required"`
}

// AssignRole assigns a role to a user or group
func AssignRole(c *gin.Context) {
	if common.IsSectionManaged("rbac") {
		c.JSON(http.StatusForbidden, gin.H{"error": common.ManagedSectionError})
		return
	}

	id := c.Param("id")
	dbID, err := strconv.ParseUint(id, 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid role id"})
		return
	}
	var req roleAssignmentReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// validate subject type
	if req.SubjectType != model.SubjectTypeUser && req.SubjectType != model.SubjectTypeGroup {
		c.JSON(http.StatusBadRequest, gin.H{"error": "subjectType must be 'user' or 'group'"})
		return
	}
	// ensure role exists
	var role model.Role
	if err := model.DB.First(&role, uint(dbID)).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "role not found"})
		return
	}

	// check exists
	var existing model.RoleAssignment
	if err := model.DB.Where("role_id = ? AND subject_type = ? AND subject = ?", role.ID, req.SubjectType, req.Subject).First(&existing).Error; err == nil {
		c.JSON(http.StatusOK, gin.H{"assignment": existing})
		return
	}

	assignment := model.RoleAssignment{
		RoleID:      role.ID,
		SubjectType: req.SubjectType,
		Subject:     req.Subject,
	}
	if err := model.DB.Create(&assignment).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create assignment: " + err.Error()})
		return
	}
	TriggerSync()
	c.JSON(http.StatusCreated, gin.H{"assignment": assignment})
}

// UnassignRole removes an assignment. Accepts query params subjectType and subject.
func UnassignRole(c *gin.Context) {
	if common.IsSectionManaged("rbac") {
		c.JSON(http.StatusForbidden, gin.H{"error": common.ManagedSectionError})
		return
	}

	id := c.Param("id")
	dbID, err := strconv.ParseUint(id, 10, 32)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid role id"})
		return
	}
	subjectType := c.Query("subjectType")
	subject := c.Query("subject")
	if subjectType == "" || subject == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "subjectType and subject query params are required"})
		return
	}
	if err := model.DB.Where("role_id = ? AND subject_type = ? AND subject = ?", uint(dbID), subjectType, subject).Delete(&model.RoleAssignment{}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to remove assignment: " + err.Error()})
		return
	}
	TriggerSync()
	c.JSON(http.StatusOK, gin.H{"success": true})
}
