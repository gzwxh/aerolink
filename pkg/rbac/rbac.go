package rbac

import (
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/zxh326/kite/pkg/common"
	"github.com/zxh326/kite/pkg/model"
	"k8s.io/klog/v2"
)

// CanAccess checks if user/oidcGroup can access resource with verb in cluster/namespace
func CanAccess(user model.User, resource, verb, cluster, namespace string) bool {
	roles := GetUserRoles(user)
	clusterScoped := namespaceUnconstrained(resource)
	for _, role := range roles {
		if !match(role.Clusters, cluster) {
			continue
		}
		if clusterScoped {
			// Cluster-scoped objects have no namespace, so the role's namespace
			// list cannot constrain them. A namespace-restricted role must name
			// such a resource explicitly: otherwise a wildcard resource grant
			// would silently widen it to cluster-wide access, e.g. "all
			// resources in namespace dev" would also grant read/write on every
			// node in the cluster.
			if namespaceRestricted(role.Namespaces) && !matchExplicit(role.Resources, resource) {
				continue
			}
		} else if !match(role.Namespaces, namespace) {
			continue
		}
		if match(role.Resources, resource) && match(role.Verbs, verb) {
			klog.V(2).Infof("RBAC Check - User: %s, OIDC Groups: %v, Resource: %s, Verb: %s, Cluster: %s, Namespace: %s, Hit Role: %v",
				user.Key(), user.OIDCGroups, resource, verb, cluster, namespace, role.Name)
			return true
		}
	}
	klog.V(2).Infof("RBAC Check - User: %s, OIDC Groups: %v, Resource: %s, Verb: %s, Cluster: %s, Namespace: %s, No Access",
		user.Key(), user.OIDCGroups, resource, verb, cluster, namespace)
	return false
}

// namespaceRestricted reports whether a role limits access to specific
// namespaces, i.e. it lists namespaces without granting every namespace.
func namespaceRestricted(namespaces []string) bool {
	if len(namespaces) == 0 {
		return false
	}
	return !contains(namespaces, "*") && !contains(namespaces, common.AllNamespaces)
}

// matchExplicit is match() with the bare "*" wildcard removed, so a wildcard
// resource grant cannot stand in for an explicit cluster-scoped grant.
func matchExplicit(list []string, val string) bool {
	if !contains(list, "*") {
		return match(list, val)
	}
	filtered := make([]string, 0, len(list))
	for _, pattern := range list {
		if pattern != "*" {
			filtered = append(filtered, pattern)
		}
	}
	return match(filtered, val)
}

// namespaceUnconstrained reports whether a resource is cluster-scoped and its
// authorization must therefore ignore the role's namespace scope. Cluster-scoped
// objects (nodes, persistent volumes, storage classes, CRDs, ...) have no
// namespace, so limiting a role to a few namespaces must not block them — only
// the cluster and resource/verb patterns apply, and for namespace-restricted
// roles only an explicit resource entry counts (see CanAccess). The
// "namespaces" resource is excluded: its name IS the authorization namespace
// and stays governed by the role's namespace list (see CanAccessNamespace).
func namespaceUnconstrained(resource string) bool {
	meta := common.LookupResource(resource)
	if meta == nil || !meta.ClusterScoped {
		return false
	}
	return resource != string(common.Namespaces)
}

// CanAccessCurrent checks the latest role configuration instead of the role
// snapshot attached during authentication. Anonymous access keeps using its
// built-in role.
func CanAccessCurrent(user model.User, resource, verb, cluster, namespace string) bool {
	if user.Username == model.AnonymousUser.Username && user.Provider == model.AnonymousUser.Provider {
		user.Roles = model.AnonymousUser.Roles
	} else {
		user.Roles = nil
	}
	return CanAccess(user, resource, verb, cluster, namespace)
}

// HasResourcePermission reports whether the user holds any role that grants
// `verb` on `resource` in `cluster`, regardless of namespace. It is used by
// the RBAC middleware to decide whether a cross-namespace LIST may pass
// through to the handler — the handler then filters items with the full
// resource permission so the user only sees objects they may access.
// Requiring a matching role here prevents zero-permission users from
// triggering list calls.
func HasResourcePermission(user model.User, resource, verb, cluster string) bool {
	roles := GetUserRoles(user)
	for _, role := range roles {
		if match(role.Clusters, cluster) &&
			match(role.Resources, resource) &&
			match(role.Verbs, verb) {
			return true
		}
	}
	return false
}

func CanAccessCluster(user model.User, name string) bool {
	roles := GetUserRoles(user)
	for _, role := range roles {
		if match(role.Clusters, name) {
			return true
		}
	}
	return false
}

func CanAccessNamespace(user model.User, cluster, name string) bool {
	roles := GetUserRoles(user)
	for _, role := range roles {
		if match(role.Clusters, cluster) && match(role.Namespaces, name) {
			return true
		}
	}
	return false
}

// GetUserRoles returns all roles for a user/oidcGroups
func GetUserRoles(user model.User) []common.Role {
	if user.Roles != nil {
		return user.Roles
	}
	rolesMap := make(map[string]common.Role)
	rwlock.RLock()
	defer rwlock.RUnlock()
	if RBACConfig == nil {
		return nil
	}
	for _, mapping := range RBACConfig.RoleMapping {
		if contains(mapping.Users, "*") || contains(mapping.Users, user.Key()) {
			if r := findRoleLocked(mapping.Name); r != nil {
				rolesMap[r.Name] = *r
			}
		}
		for _, group := range user.OIDCGroups {
			if contains(mapping.OIDCGroups, group) {
				if r := findRoleLocked(mapping.Name); r != nil {
					rolesMap[r.Name] = *r
				}
			}
		}
	}
	roles := make([]common.Role, 0, len(rolesMap))
	for _, role := range rolesMap {
		roles = append(roles, role)
	}
	return roles
}

func findRoleLocked(name string) *common.Role {
	for _, r := range RBACConfig.Roles {
		if r.Name == name {
			return &r
		}
	}
	return nil
}

func match(list []string, val string) bool {
	for _, pattern := range list {
		if len(pattern) > 1 && strings.HasPrefix(pattern, "!") && matchPattern(pattern[1:], val) {
			return false
		}
	}
	for _, pattern := range list {
		if strings.HasPrefix(pattern, "!") {
			continue
		}
		if matchPattern(pattern, val) {
			return true
		}
	}
	return false
}

func matchPattern(pattern, val string) bool {
	if pattern == "*" || pattern == val {
		return true
	}
	// Plain values are literals; dots are common in Kubernetes API group names.
	if !strings.ContainsAny(pattern, `\^$*+?()[]{}|`) {
		return false
	}
	re, err := regexp.Compile("^(?:" + pattern + ")$")
	if err != nil {
		klog.Error(err)
		return false
	}
	return re.MatchString(val)
}

func contains(list []string, val string) bool {
	return slices.Contains(list, val)
}

func NoAccess(user, verb, resource, ns, cluster string) string {
	if ns == "" {
		return fmt.Sprintf("user %s does not have permission to %s %s on cluster %s",
			user, verb, resource, cluster)
	}
	if ns == common.AllNamespaces {
		ns = "All"
	}
	return fmt.Sprintf("user %s does not have permission to %s %s in namespace %s on cluster %s",
		user, verb, resource, ns, cluster)
}

func UserHasRole(user model.User, roleName string) bool {
	roles := GetUserRoles(user)
	for _, role := range roles {
		if role.Name == roleName {
			return true
		}
	}
	return false
}
