package internal

import (
	"os"
	"path/filepath"

	"aerolink/pkg/cluster"
	"aerolink/pkg/common"
	"aerolink/pkg/model"
	"aerolink/pkg/rbac"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/util/homedir"
	"k8s.io/klog/v2"
)

var (
	aerolinkUsername = common.Getenv("USERNAME")
	aerolinkPassword = common.Getenv("PASSWORD")
)

func loadUser() error {
	if aerolinkUsername != "" && aerolinkPassword != "" {
		uc, err := model.CountUsers()
		if err == nil && uc == 0 {
			klog.Infof("Creating super user %s from environment variables", aerolinkUsername)
			u := &model.User{
				Username: aerolinkUsername,
				Password: aerolinkPassword,
			}
			err := model.AddSuperUser(u)
			if err == nil {
				rbac.SyncNow <- struct{}{}
			} else {
				return err
			}
		}
	}

	return nil
}

func loadClusters() error {
	cc, err := model.CountClusters()
	if err != nil || cc > 0 {
		return err
	}
	kubeconfigpath := ""
	if home := homedir.HomeDir(); home != "" {
		kubeconfigpath = filepath.Join(home, ".kube", "config")
	}

	if envKubeconfig := os.Getenv("KUBECONFIG"); envKubeconfig != "" {
		kubeconfigpath = envKubeconfig
	}

	config, _ := os.ReadFile(kubeconfigpath)

	if len(config) == 0 {
		return nil
	}
	kubeconfig, err := clientcmd.Load(config)
	if err != nil {
		return err
	}

	klog.Infof("Importing clusters from kubeconfig: %s", kubeconfigpath)
	if _, err := cluster.ImportClustersFromKubeconfig(kubeconfig, true, nil); err != nil {
		return err
	}
	return nil
}

func LoadConfigFromEnv() {
	// 环境变量路径也要应用审计落地方式（AEROLINK_AUDIT_SINK）：不提供配置文件时只有这条路
	// （有配置文件时走 LoadConfigFromFile → applyConfig，app.go 里二者只会跑一个）。
	// 漏了它的话，「只设 AEROLINK_AUDIT_SINK、不挂 config.yaml」的部署会静静地按 database 跑。
	applyAuditSink("")

	if !common.IsSectionManaged("superUser") {
		if err := loadUser(); err != nil {
			klog.Warningf("Failed to migrate env to db user: %v", err)
		}
	}
	if !common.IsSectionManaged("clusters") {
		if err := loadClusters(); err != nil {
			klog.Warningf("Failed to migrate env to db cluster: %v", err)
		}
	}
}
