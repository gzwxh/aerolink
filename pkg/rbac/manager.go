package rbac

import (
	"fmt"
	"sync"
	"time"

	"aerolink/pkg/common"
	"aerolink/pkg/model"
	"k8s.io/klog/v2"
)

var (
	RBACConfig *common.RolesConfig
	once       sync.Once
	rwlock     sync.RWMutex
)

func InitRBAC() {
	once.Do(func() {
		if err := model.InitDefaultRole(); err != nil {
			panic(fmt.Sprintf("failed to init default roles: %v", err))
		}
		// 内置角色的定义变更（如等保三权分立、超级角色并入系统管理员）只在这一步
		// 落到已有数据库上，之后管理员在控制台做的调整不会再被启动覆盖。
		if err := model.MigrateSystemRoleRules(); err != nil {
			klog.Errorf("failed to migrate built-in role rules: %v", err)
		}
		// 代次 3 的单向迁移：删掉老库里的内置超级角色行（权限已被系统管理员覆盖）。
		if err := model.RetireSuperRole(); err != nil {
			klog.Errorf("failed to retire the built-in super role: %v", err)
		}
		// 角色不再带集群属性（全局）：存量角色里写死的集群限制一次性归一化。
		if err := model.NormalizeRoleClusters(); err != nil {
			klog.Errorf("failed to normalize role clusters: %v", err)
		}
		go SyncRolesConfig()
	})
}

// toCommonGrants 把落库的资源授权转换成缓存里的形式。
func toCommonGrants(grants model.ResourceGrants) []common.ResourceGrant {
	if len(grants) == 0 {
		return nil
	}
	converted := make([]common.ResourceGrant, 0, len(grants))
	for _, grant := range grants {
		converted = append(converted, common.ResourceGrant{
			Resource: grant.Resource,
			Verbs:    grant.Verbs,
		})
	}
	return converted
}

// loadRolesFromDB 用数据库中的行填充 RBACConfig
func loadRolesFromDB() error {
	cfg := &common.RolesConfig{
		Roles:       []common.Role{},
		RoleMapping: []common.RoleMapping{},
	}

	var roles []model.Role
	if err := model.DB.Preload("Assignments").Find(&roles).Error; err != nil {
		return err
	}

	for _, r := range roles {
		cr := common.Role{
			Name:        r.Name,
			Description: r.Description,
			Clusters:    r.Clusters,
			Namespaces:  r.Namespaces,
			Resources:   r.Resources,
			Verbs:       r.Verbs,
			Grants:      toCommonGrants(r.Grants),
		}
		cfg.Roles = append(cfg.Roles, cr)

		for _, a := range r.Assignments {
			rm := common.RoleMapping{
				Name: cr.Name,
			}
			if a.SubjectType == model.SubjectTypeUser {
				rm.Users = append(rm.Users, a.Subject)
			} else {
				rm.OIDCGroups = append(rm.OIDCGroups, a.Subject)
			}
			cfg.RoleMapping = append(cfg.RoleMapping, rm)
		}
	}
	rwlock.Lock()
	RBACConfig = cfg
	rwlock.Unlock()
	return nil
}

var (
	SyncNow = make(chan struct{}, 1)
)

// TriggerSync 发出一个非阻塞信号，用于从数据库刷新 RBAC 配置。
func TriggerSync() {
	select {
	case SyncNow <- struct{}{}:
	default:
	}
}

func SyncRolesConfig() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	TriggerSync()
	for {
		select {
		case <-ticker.C:
		case <-SyncNow:
		}
		if err := loadRolesFromDB(); err != nil {
			klog.Errorf("failed to sync rbac from db: %v", err)
		}
		if err := loadBindingGroupsFromDB(); err != nil {
			klog.Errorf("failed to sync projects from db: %v", err)
		}
	}
}
