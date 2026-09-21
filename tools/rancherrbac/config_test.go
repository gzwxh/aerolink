package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeConfigFile(t *testing.T, name, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("写测试配置失败：%v", err)
	}
	return path
}

func TestLoadConfigFileReadsYAML(t *testing.T) {
	path := writeConfigFile(t, "rancherrbac.yaml", `
rancher:
  url: https://rancher.example.com
  token: token-abc:def
  insecure: true
kite:
  url: https://kite.example.com
  token: kite1-secret
clusterMap:
  local: dev
  c-m-abc123: prod
userMap:
  bob: robert
groupMap:
  devs: developers
namespacesSource: v3
prefix: rk-
timeout: 90s
verbose: true
skipClusterGrants: true
replaceMembers: true
replaceNamespaces: true
widenResourceNames: true
dumpDir: /tmp/dump
fromDir: /tmp/from
planOut: /tmp/plan.json
`)

	cfg, err := loadConfigFile(path)
	if err != nil {
		t.Fatalf("解析配置失败：%v", err)
	}
	if cfg.Rancher.URL != "https://rancher.example.com" || cfg.Rancher.Token != "token-abc:def" || !cfg.Rancher.Insecure {
		t.Fatalf("rancher = %#v", cfg.Rancher)
	}
	if cfg.Kite.URL != "https://kite.example.com" || cfg.Kite.Token != "kite1-secret" || cfg.Kite.Insecure {
		t.Fatalf("kite = %#v", cfg.Kite)
	}
	if cfg.ClusterMap["local"] != "dev" || cfg.ClusterMap["c-m-abc123"] != "prod" {
		t.Fatalf("clusterMap = %#v", cfg.ClusterMap)
	}
	if cfg.UserMap["bob"] != "robert" || cfg.GroupMap["devs"] != "developers" {
		t.Fatalf("userMap / groupMap = %#v / %#v", cfg.UserMap, cfg.GroupMap)
	}
	if cfg.NamespacesSource != "v3" || cfg.Prefix != "rk-" {
		t.Fatalf("namespacesSource / prefix = %q / %q", cfg.NamespacesSource, cfg.Prefix)
	}
	if time.Duration(cfg.Timeout) != 90*time.Second {
		t.Fatalf("timeout = %v", time.Duration(cfg.Timeout))
	}
	if !cfg.Verbose || !cfg.SkipClusterGrants || !cfg.ReplaceMembers || !cfg.ReplaceNamespaces || !cfg.WidenResourceNames {
		t.Fatalf("布尔开关 = %#v", cfg)
	}
	if cfg.DumpDir != "/tmp/dump" || cfg.FromDir != "/tmp/from" || cfg.PlanOut != "/tmp/plan.json" {
		t.Fatalf("目录类参数 = %#v", cfg)
	}
}

// 秒数写法（timeout: 30）与时长写法（"30s"）都应当被接受：写配置文件的人两种都会写。
func TestLoadConfigFileAcceptsTimeoutAsSeconds(t *testing.T) {
	path := writeConfigFile(t, "rancherrbac.yaml", "timeout: 30\n")
	cfg, err := loadConfigFile(path)
	if err != nil {
		t.Fatalf("解析配置失败：%v", err)
	}
	if time.Duration(cfg.Timeout) != 30*time.Second {
		t.Fatalf("timeout = %v，期望 30s", time.Duration(cfg.Timeout))
	}

	bad := writeConfigFile(t, "bad.yaml", "timeout: 一会儿\n")
	if _, err := loadConfigFile(bad); err == nil {
		t.Fatal("无法解析的 timeout 应当报错")
	}
}

func TestLoadConfigFileAcceptsJSON(t *testing.T) {
	path := writeConfigFile(t, "rancherrbac.json", `{
	  "rancher": {"url": "https://rancher.example.com", "token": "token-abc:def"},
	  "kite": {"url": "https://kite.example.com", "token": "kite1-secret"},
	  "clusterMap": {"local": "dev"},
	  "timeout": 45
	}`)

	cfg, err := loadConfigFile(path)
	if err != nil {
		t.Fatalf("解析 JSON 配置失败：%v", err)
	}
	if cfg.Rancher.Token != "token-abc:def" || cfg.ClusterMap["local"] != "dev" {
		t.Fatalf("JSON 配置 = %#v", cfg)
	}
	if time.Duration(cfg.Timeout) != 45*time.Second {
		t.Fatalf("timeout = %v，期望 45s", time.Duration(cfg.Timeout))
	}
}

// 键名写错不能静默忽略：漏掉一个 clusterMap 会悄悄少迁一整个集群。
func TestLoadConfigFileRejectsUnknownKeys(t *testing.T) {
	cases := map[string]string{
		"写错键名":  "kite:\n  ur: https://kite.example.com\n",
		"顶层未知键": "rancher-url: https://rancher.example.com\n",
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			path := writeConfigFile(t, "rancherrbac.yaml", content)
			_, err := loadConfigFile(path)
			if err == nil {
				t.Fatal("未知键应当报错，而不是被忽略")
			}
			if !strings.Contains(err.Error(), "解析配置文件") {
				t.Fatalf("错误信息应当指出是配置文件的解析问题：%v", err)
			}
		})
	}
}

// 写入类开关故意不支持写进配置文件：会被反复复用，不该在里面定死「落库」。
func TestLoadConfigFileRejectsWriteSwitches(t *testing.T) {
	for _, key := range []string{"apply", "cleanup", "yes"} {
		t.Run(key, func(t *testing.T) {
			path := writeConfigFile(t, "rancherrbac.yaml", "kite:\n  url: https://kite.example.com\n"+key+": true\n")
			_, err := loadConfigFile(path)
			if err == nil {
				t.Fatalf("%s 不该被配置文件接受", key)
			}
			if !strings.Contains(err.Error(), "只能在命令行上给") {
				t.Fatalf("错误信息应当说明这几个开关只能在命令行上给：%v", err)
			}
		})
	}
}

// 优先级：命令行 > 环境变量 > 配置文件 > 默认值。
func TestLoadOptionsLayering(t *testing.T) {
	path := writeConfigFile(t, "rancherrbac.yaml", `
rancher:
  url: https://rancher.from-config
  token: token-config:secret
kite:
  url: https://kite.from-config
  token: kite1-from-config
clusterMap:
  local: dev
  c-1: one
timeout: 30s
namespacesSource: v1
`)
	t.Setenv("RANCHER_URL", "https://rancher.from-env")
	t.Setenv("RANCHER_TOKEN", "")
	t.Setenv("KITE_URL", "")
	t.Setenv("KITE_TOKEN", "")

	opts, err := loadOptions([]string{"-config", path})
	if err != nil {
		t.Fatalf("组装参数失败：%v", err)
	}
	if opts.rancherURL != "https://rancher.from-env" {
		t.Fatalf("环境变量应当优先于配置文件：%q", opts.rancherURL)
	}
	// 环境变量没给的字段继续用配置文件里的值。
	if opts.rancherToken != "token-config:secret" || opts.kiteURL != "https://kite.from-config" ||
		opts.kiteToken != "kite1-from-config" {
		t.Fatalf("配置文件的值被丢了：%#v", opts)
	}
	if opts.timeout != 30*time.Second || opts.namespacesSource != sourceV1 {
		t.Fatalf("timeout / namespacesSource = %v / %q", opts.timeout, opts.namespacesSource)
	}
	if opts.configPath != path {
		t.Fatalf("configPath = %q，期望 %q", opts.configPath, path)
	}

	// 命令行最优先；映射表按 key 合并（配置文件里的键保留）。
	opts, err = loadOptions([]string{"-config", path,
		"-rancher-url", "https://rancher.from-cli",
		"-timeout", "5s",
		"-cluster-map", "c-1=uno",
		"-cluster-map", "c-2=two",
	})
	if err != nil {
		t.Fatalf("组装参数失败：%v", err)
	}
	if opts.rancherURL != "https://rancher.from-cli" {
		t.Fatalf("命令行应当最优先：%q", opts.rancherURL)
	}
	if opts.timeout != 5*time.Second {
		t.Fatalf("timeout = %v，期望 5s", opts.timeout)
	}
	maps := opts.clusterMaps.values
	if maps["local"] != "dev" || maps["c-1"] != "uno" || maps["c-2"] != "two" {
		t.Fatalf("映射表应合并而不是整体替换：%#v", maps)
	}
	// 命令行没碰的字段仍然来自配置文件。
	if opts.kiteToken != "kite1-from-config" {
		t.Fatalf("kiteToken = %q", opts.kiteToken)
	}
}

// 没给 -config 时按当前目录的默认文件名找；显式给了 -config "" 则不找。
func TestLoadOptionsFindsConfigInWorkingDirectory(t *testing.T) {
	dir := t.TempDir()
	content := []byte("kite:\n  url: https://kite.from-cwd\n  token: kite1-from-cwd\n")
	if err := os.WriteFile(filepath.Join(dir, "rancherrbac.yaml"), content, 0o600); err != nil {
		t.Fatalf("写测试配置失败：%v", err)
	}
	t.Chdir(dir)

	opts, err := loadOptions(nil)
	if err != nil {
		t.Fatalf("组装参数失败：%v", err)
	}
	if opts.kiteURL != "https://kite.from-cwd" || opts.configPath != "rancherrbac.yaml" {
		t.Fatalf("应当自动用当前目录的配置：%#v", opts)
	}

	// -config "" 明确表示不用配置文件。
	opts, err = loadOptions([]string{"-config", ""})
	if err != nil {
		t.Fatalf("组装参数失败：%v", err)
	}
	if opts.kiteURL != "" || opts.configPath != "" {
		t.Fatalf("-config \"\" 应当跳过配置文件：%#v", opts)
	}
}

// -config 指向不存在的文件要报错，不能静默改用默认值（避免「以为在用某份配置」）。
func TestLoadOptionsReportsUnreadableConfig(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "nope.yaml")
	_, err := loadOptions([]string{"-config", missing})
	if err == nil || !strings.Contains(err.Error(), "-config 指定的配置文件不可用") {
		t.Fatalf("错误信息不明确：%v", err)
	}

	t.Setenv(configEnvVar, missing)
	_, err = loadOptions(nil)
	if err == nil || !strings.Contains(err.Error(), configEnvVar) {
		t.Fatalf("环境变量指错时应当说清来源：%v", err)
	}
}

func TestValidateOptionsRejectsUnknownNamespaceSource(t *testing.T) {
	path := writeConfigFile(t, "rancherrbac.yaml", "namespacesSource: 随便\n")
	if _, err := loadOptions([]string{"-config", path}); err == nil {
		t.Fatal("未知的 namespaces-source 应当报错")
	}
}

// -init-config 生成的模板必须能被自己解析：模板里的键名写错就等于在教用户写错。
func TestConfigTemplateIsLoadable(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	if err := writeConfigTemplate("rancherrbac.yaml"); err != nil {
		t.Fatalf("生成模板失败：%v", err)
	}
	cfg, err := loadConfigFile("rancherrbac.yaml")
	if err != nil {
		t.Fatalf("模板解析失败：%v", err)
	}
	if cfg.Rancher.URL == "" || cfg.Kite.URL == "" || cfg.ClusterMap["local"] != "dev" {
		t.Fatalf("模板内容不完整：%#v", cfg)
	}
	// 模板会被直接拿来跑，不该带出「解析失败」。
	if _, err := loadOptions(nil); err != nil {
		t.Fatalf("用模板组参失败：%v", err)
	}

	info, err := os.Stat("rancherrbac.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("模板权限 = %v，期望 600（里面有密钥）", info.Mode().Perm())
	}

	// 已存在的文件不覆盖：里面可能已经填好密钥了。
	if err := writeConfigTemplate("rancherrbac.yaml"); err == nil {
		t.Fatal("已存在的配置文件不该被覆盖")
	}
}

// -init-config 只生成模板，不该要求先填好地址。
func TestInitConfigSkipsValidation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rancherrbac.yaml")
	opts, err := loadOptions([]string{"-init-config", path})
	if err != nil {
		t.Fatalf("组装参数失败：%v", err)
	}
	if opts.initConfig != path {
		t.Fatalf("initConfig = %q", opts.initConfig)
	}
}
