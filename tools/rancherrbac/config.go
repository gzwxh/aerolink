package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// 迁移工具要跑在别人的环境里，参数不适合只靠命令行与环境变量传递：一次配置会反复复用，
// 集群映射 / 用户组映射这类内容也不适合每次手敲。所以除了命令行与环境变量，还支持一份
// 配置文件（YAML 或 JSON，键名与命令行参数一一对应）。
//
// 取值优先级：命令行 > 环境变量 > 配置文件 > 内置默认值。
const (
	configEnvVar = "RANCHER_RBAC_CONFIG"
	// configFileName 是没有 -config 时在当前目录查找的文件名。
	configFileName = "rancherrbac"
)

// autoConfigNames 是没有显式指定配置文件时，依次在当前目录查找的名字。
var autoConfigNames = []string{configFileName + ".yaml", configFileName + ".yml", configFileName + ".json"}

// fileConfig 是配置文件的结构。键名用 camelCase，与命令行参数一一对应。
//
// 写入类开关（apply / cleanup / yes）故意不在这里：配置文件会被反复复用，一旦把
// 「落库」写进去，之后每次只想看看计划的执行都会变成真写；清理那对更是危险。
type fileConfig struct {
	Rancher fileEndpoint `yaml:"rancher" json:"rancher"`
	// AeroLink 是新的键名；Kite 是退役的旧键名，只为了不改老配置而保留，
	// 两者同时给出时以 AeroLink 为准（见 applyConfig）。
	AeroLink fileEndpoint `yaml:"aerolink" json:"aerolink"`
	Kite     fileEndpoint `yaml:"kite" json:"kite"`

	ClusterMap map[string]string `yaml:"clusterMap" json:"clusterMap"`
	UserMap    map[string]string `yaml:"userMap" json:"userMap"`
	GroupMap   map[string]string `yaml:"groupMap" json:"groupMap"`

	NamespacesSource   string        `yaml:"namespacesSource" json:"namespacesSource"`
	Prefix             string        `yaml:"prefix" json:"prefix"`
	SkipClusterGrants  bool          `yaml:"skipClusterGrants" json:"skipClusterGrants"`
	ReplaceMembers     bool          `yaml:"replaceMembers" json:"replaceMembers"`
	ReplaceNamespaces  bool          `yaml:"replaceNamespaces" json:"replaceNamespaces"`
	WidenResourceNames bool          `yaml:"widenResourceNames" json:"widenResourceNames"`
	DumpDir            string        `yaml:"dumpDir" json:"dumpDir"`
	FromDir            string        `yaml:"fromDir" json:"fromDir"`
	PlanOut            string        `yaml:"planOut" json:"planOut"`
	Timeout            durationValue `yaml:"timeout" json:"timeout"`
	Verbose            bool          `yaml:"verbose" json:"verbose"`
}

// fileEndpoint 是配置文件里 Rancher / AeroLink（旧键名 kite）两端的连接信息。
type fileEndpoint struct {
	URL      string `yaml:"url" json:"url"`
	Token    string `yaml:"token" json:"token"`
	Insecure bool   `yaml:"insecure" json:"insecure"`
}

// durationValue 让配置文件里的时间段既能写 "60s" / "1m"，也能直接写秒数（60）。
type durationValue time.Duration

func (d *durationValue) UnmarshalYAML(value *yaml.Node) error {
	return d.set(value.Value)
}

func (d *durationValue) UnmarshalJSON(data []byte) error {
	var raw any
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	switch value := raw.(type) {
	case nil:
		*d = 0
		return nil
	case float64:
		*d = durationValue(time.Duration(value * float64(time.Second)))
		return nil
	case string:
		return d.set(value)
	}
	return fmt.Errorf("timeout 应该是 \"60s\" 这样的时长或秒数，得到 %s", string(data))
}

func (d *durationValue) set(raw string) error {
	raw = strings.TrimSpace(strings.Trim(strings.TrimSpace(raw), `"'`))
	if raw == "" {
		*d = 0
		return nil
	}
	if seconds, err := strconv.Atoi(raw); err == nil {
		*d = durationValue(time.Duration(seconds) * time.Second)
		return nil
	}
	parsed, err := time.ParseDuration(raw)
	if err != nil {
		return fmt.Errorf("timeout 解析失败（写 \"60s\" / \"1m\" 或秒数）：%w", err)
	}
	*d = durationValue(parsed)
	return nil
}

// loadOptions 组装运行参数：默认值 → 配置文件 → 环境变量 → 命令行。
//
// 先按命令行解析一遍是为了知道「哪些参数是显式给出的」——只有显式给出的才覆盖前几层，
// 否则命令行上的零值会把配置文件里的值抹掉。
func loadOptions(args []string) (options, error) {
	cli, set, err := parseFlags(args)
	if err != nil {
		return options{}, err
	}
	// -init-config / -version 只是「做一件事就退出」，不看其它参数
	// （否则还没有配置文件就要先填地址）。
	if cli.initConfig != "" || cli.showVersion {
		return cli, nil
	}

	opts := defaultOptions()

	configPath, err := resolveConfigPath(cli, set)
	if err != nil {
		return options{}, err
	}
	if configPath != "" {
		cfg, err := loadConfigFile(configPath)
		if err != nil {
			return options{}, err
		}
		applyConfig(&opts, cfg)
		warnIfConfigIsReadableByOthers(configPath)
		opts.configPath = configPath
	}

	applyEnv(&opts)
	applyCLI(&opts, cli, set)

	if err := validateOptions(opts); err != nil {
		return options{}, err
	}
	return opts, nil
}

func defaultOptions() options {
	return options{
		namespacesSource: sourceAuto,
		prefix:           defaultNamePrefix,
		timeout:          60 * time.Second,
		clusterMaps:      kvFlag{values: map[string]string{}},
		userMaps:         kvFlag{values: map[string]string{}},
		groupMaps:        kvFlag{values: map[string]string{}},
	}
}

// resolveConfigPath 定位配置文件：-config 显式指定 > $RANCHER_RBAC_CONFIG > 当前目录的默认文件名。
// 显式指定但读不到时报错（而不是静默改用默认值，避免「以为在用某份配置」）。
func resolveConfigPath(cli options, set map[string]bool) (string, error) {
	if set["config"] {
		// -config "" 表示「不用配置文件」，也不去当前目录找。
		if cli.configPath == "" {
			return "", nil
		}
		if err := checkConfigExists(cli.configPath, "-config 指定的配置文件"); err != nil {
			return "", err
		}
		return cli.configPath, nil
	}
	if fromEnv := envOr(configEnvVar); fromEnv != "" {
		if err := checkConfigExists(fromEnv, "环境变量 "+configEnvVar+" 指向的配置文件"); err != nil {
			return "", err
		}
		return fromEnv, nil
	}
	for _, name := range autoConfigNames {
		if info, err := os.Stat(name); err == nil && !info.IsDir() {
			return name, nil
		}
	}
	return "", nil
}

func checkConfigExists(path, subject string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("%s不可用：%w", subject, err)
	}
	if info.IsDir() {
		return fmt.Errorf("%s是个目录，不是文件：%s", subject, path)
	}
	return nil
}

// loadConfigFile 读配置文件。键名写错直接报错，不静默忽略：配置里的错别字最难发现，
// 而漏掉一个 clusterMap 会悄悄少迁一整个集群。
func loadConfigFile(path string) (fileConfig, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return fileConfig{}, fmt.Errorf("读取配置文件失败：%w", err)
	}

	var cfg fileConfig
	if strings.EqualFold(filepath.Ext(path), ".json") {
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&cfg); err != nil && !errors.Is(err, io.EOF) {
			return fileConfig{}, configParseError(path, err)
		}
		return cfg, nil
	}

	decoder := yaml.NewDecoder(bytes.NewReader(raw))
	decoder.KnownFields(true)
	if err := decoder.Decode(&cfg); err != nil && !errors.Is(err, io.EOF) {
		return fileConfig{}, configParseError(path, err)
	}
	return cfg, nil
}

func configParseError(path string, err error) error {
	return fmt.Errorf("解析配置文件 %s 失败：%w\n"+
		"提示：写入类开关（-apply / -cleanup / -yes）只能在命令行上给；"+
		"键名写错、缩进不对也会报在这里。可用的键名见 `rancherrbac -init-config <文件>` 生成的模板", path, err)
}

// applyConfig 用配置文件里的值覆盖默认值；配置文件里没写的（零值）保持不动。
func applyConfig(opts *options, cfg fileConfig) {
	if cfg.Rancher.URL != "" {
		opts.rancherURL = cfg.Rancher.URL
	}
	if cfg.Rancher.Token != "" {
		opts.rancherToken = cfg.Rancher.Token
	}
	// 三个布尔开关只可能被「打开」：命令行没有反向开关，且客户端不校验证书这类放宽
	// 设定更适合靠显式命令行覆盖（见 applyCLI）。
	opts.rancherInsecure = opts.rancherInsecure || cfg.Rancher.Insecure

	// kite 是退役的旧键名，aerolink 是新名；按顺序覆盖，两者都写时以 aerolink 为准。
	for _, endpoint := range []fileEndpoint{cfg.Kite, cfg.AeroLink} {
		if endpoint.URL != "" {
			opts.kiteURL = endpoint.URL
		}
		if endpoint.Token != "" {
			opts.kiteToken = endpoint.Token
		}
		opts.kiteInsecure = opts.kiteInsecure || endpoint.Insecure
	}

	if cfg.NamespacesSource != "" {
		opts.namespacesSource = cfg.NamespacesSource
	}
	if cfg.Prefix != "" {
		opts.prefix = cfg.Prefix
	}
	opts.skipClusterGrants = opts.skipClusterGrants || cfg.SkipClusterGrants
	opts.replaceMembers = opts.replaceMembers || cfg.ReplaceMembers
	opts.replaceNamespaces = opts.replaceNamespaces || cfg.ReplaceNamespaces
	opts.widenResourceNames = opts.widenResourceNames || cfg.WidenResourceNames

	if cfg.DumpDir != "" {
		opts.dumpDir = cfg.DumpDir
	}
	if cfg.FromDir != "" {
		opts.fromDir = cfg.FromDir
	}
	if cfg.PlanOut != "" {
		opts.planOut = cfg.PlanOut
	}
	if cfg.Timeout > 0 {
		opts.timeout = time.Duration(cfg.Timeout)
	}
	opts.verbose = opts.verbose || cfg.Verbose

	opts.clusterMaps.values = copyMap(cfg.ClusterMap)
	opts.userMaps.values = copyMap(cfg.UserMap)
	opts.groupMaps.values = copyMap(cfg.GroupMap)
}

// applyEnv 应用环境变量。只覆盖非空值，未设置的环境变量不参与。
func applyEnv(opts *options) {
	for _, item := range []struct {
		key    string
		target *string
	}{
		{"RANCHER_URL", &opts.rancherURL},
		{"RANCHER_TOKEN", &opts.rancherToken},
		// KITE_URL / KITE_TOKEN 是退役的旧名，保留兼容；列表按顺序覆盖，新名排在后面，
		// 两个都设置时以新名为准。
		{"KITE_URL", &opts.kiteURL},
		{"AEROLINK_URL", &opts.kiteURL},
		{"KITE_TOKEN", &opts.kiteToken},
		{"AEROLINK_TOKEN", &opts.kiteToken},
	} {
		if value := envOr(item.key); value != "" {
			*item.target = value
		}
	}
}

// applyCLI 用命令行上显式给出的值覆盖前面几层。只看 set 里记下的参数名，
// 否则命令行上的零值会把配置文件里配好的值抹掉。
func applyCLI(opts *options, cli options, set map[string]bool) {
	for _, item := range []struct {
		name   string
		source string
		target *string
	}{
		{"rancher-url", cli.rancherURL, &opts.rancherURL},
		{"rancher-token", cli.rancherToken, &opts.rancherToken},
		{"aerolink-url", cli.kiteURL, &opts.kiteURL},
		{"aerolink-token", cli.kiteToken, &opts.kiteToken},
		{"plan-out", cli.planOut, &opts.planOut},
		{"dump-dir", cli.dumpDir, &opts.dumpDir},
		{"from-dir", cli.fromDir, &opts.fromDir},
		{"prefix", cli.prefix, &opts.prefix},
		{"namespaces-source", cli.namespacesSource, &opts.namespacesSource},
	} {
		if set[item.name] {
			*item.target = item.source
		}
	}

	opts.rancherInsecure = opts.rancherInsecure || (set["rancher-insecure"] && cli.rancherInsecure)
	opts.kiteInsecure = opts.kiteInsecure || (set["aerolink-insecure"] && cli.kiteInsecure)
	opts.skipClusterGrants = opts.skipClusterGrants || (set["skip-cluster-grants"] && cli.skipClusterGrants)
	opts.replaceMembers = opts.replaceMembers || (set["replace-members"] && cli.replaceMembers)
	opts.replaceNamespaces = opts.replaceNamespaces || (set["replace-namespaces"] && cli.replaceNamespaces)
	opts.widenResourceNames = opts.widenResourceNames || (set["widen-resource-names"] && cli.widenResourceNames)
	opts.verbose = opts.verbose || (set["v"] && cli.verbose)
	opts.cleanup = set["cleanup"] && cli.cleanup
	opts.yes = set["yes"] && cli.yes
	opts.apply = set["apply"] && cli.apply
	if set["timeout"] {
		opts.timeout = cli.timeout
	}

	// 映射表按 key 合并：命令行上给的键覆盖配置文件，其余保留。
	if set["cluster-map"] {
		mergeMap(opts.clusterMaps.values, cli.clusterMaps.values)
	}
	if set["user-map"] {
		mergeMap(opts.userMaps.values, cli.userMaps.values)
	}
	if set["group-map"] {
		mergeMap(opts.groupMaps.values, cli.groupMaps.values)
	}
}

func validateOptions(opts options) error {
	switch opts.namespacesSource {
	case sourceAuto, sourceV1, sourceV3:
	default:
		return fmt.Errorf("namespaces-source 只能是 %s / %s / %s，当前是 %q",
			sourceAuto, sourceV1, sourceV3, opts.namespacesSource)
	}
	return nil
}

func copyMap(source map[string]string) map[string]string {
	out := make(map[string]string, len(source))
	for key, value := range source {
		out[key] = value
	}
	return out
}

func mergeMap(target, overlay map[string]string) {
	if target == nil {
		return
	}
	for key, value := range overlay {
		target[key] = value
	}
}

// warnIfConfigIsReadableByOthers 提醒配置文件的权限：里面有 Rancher 与 Kite 的密钥。
func warnIfConfigIsReadableByOthers(path string) {
	if runtime.GOOS == "windows" {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		return
	}
	if info.Mode().Perm()&0o077 != 0 {
		fmt.Fprintf(os.Stderr, "⚠ 配置文件 %s 对同组/其他用户可读，里面存着 API 密钥，建议 chmod 600\n", path)
	}
}

// writeConfigTemplate 生成配置文件模板。-init-config 指向已存在的文件时拒绝覆盖：
// 那是别人已经填好密钥的配置，覆盖掉不可恢复。
func writeConfigTemplate(path string) error {
	if _, err := os.Stat(path); err == nil {
		return fmt.Errorf("文件已存在，不覆盖：%s（要重新生成先把它移走）", path)
	} else if !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("检查目标文件失败：%w", err)
	}
	if err := os.WriteFile(path, []byte(configTemplate), 0o600); err != nil {
		return fmt.Errorf("写入配置模板失败：%w", err)
	}
	fmt.Printf("已生成配置模板：%s（权限 600，填好后用 -config %s 使用）\n", path, path)
	return nil
}

const configTemplate = `# Rancher → AeroLink 授权迁移的配置模板（rancherrbac -init-config 生成）。
#
# 用法：
#   rancherrbac -config rancherrbac.yaml                       # 只读：打印计划
#   rancherrbac -config rancherrbac.yaml -plan-out plan.json   # 把计划存成 JSON 留档
#   rancherrbac -config rancherrbac.yaml -apply                # 确认无误后落库
#
# 取值优先级：命令行 > 环境变量 > 本文件 > 内置默认值。
# 配置文件也可以靠环境变量 RANCHER_RBAC_CONFIG 指定；都没有时按当前目录的
# rancherrbac.yaml / .yml / .json 依次找。
#
# 本文件存的是 API 密钥：建议 chmod 600，且不要进版本库。
# 写入类开关（apply / cleanup / yes）只能在命令行上给，写进本文件会直接报错——
# 配置文件会被反复复用，把「落库」写死在里面，之后每次想看看计划的执行都会变成真写。

rancher:
  # Rancher 地址，形如 https://rancher.example.com
  url: https://rancher.example.com
  # Rancher 界面 → 右上角头像 → 用户设置 → API Keys 新建，把 Access Key 与 Secret Key
  # 拼成 token-xxxxx:yyyyy。
  token: token-xxxxx:yyyyy
  # Rancher 常用自签名证书；报 x509 之类的证书错误时置 true。
  insecure: true

# AeroLink 控制台的连接信息（退役的旧键名 kite: 仍然可用，两个都写时以 aerolink 为准）。
aerolink:
  # AeroLink 控制台地址。
  url: https://aerolink.example.com
  # AeroLink 控制台 → 账号设置 → API Keys 新建，填完整的 kite1-xxxxxxxx。
  token: kite1-xxxxxxxx
  insecure: false

# Rancher 集群 ID → AeroLink 集群名。同名时工具会自动匹配；匹配不上、或有多个同名集群时
# 必须在这里显式给出，否则该集群整体跳过（并写进报告的「提示与跳过项」）。
clusterMap:
  local: dev
  # c-m-hrczlc8w: bigdata-center

# 两边账号名 / 组名不一致时的对应关系，默认按名字原样对齐。
# 用户组尤其常需要映射：AD / LDAP 组名是按 principalId 推导出来的，可能与 AeroLink 里
# 目录同步过来的组名不同。
userMap: {}
groupMap: {}

# 命名空间归属从 Rancher 的哪个接口读：
#   auto  先 Steve（/v1/namespaces，字段最全），读不全时用 Norman（/v3/namespaces）补齐
#   v1    只用 Steve
#   v3    只用 Norman
# 注意：这两个接口都只覆盖 Rancher 的 local 集群；其余集群的命名空间要另行导出后
# 用 fromDir 跑（见 README）。
namespacesSource: auto

# 角色名与绑定组名的前缀。默认空：角色名用 Rancher 的角色模板 ID（project-owner 等），
# 绑定组名用 Rancher 上的项目名，界面上与 Rancher 一一对应。
# 填了前缀则两者都加前缀，-cleanup 时也按前缀圈定该删哪些。
prefix: ""

# 单个 HTTP 请求的超时时间，可写 "60s" / "1m"，也可以直接写秒数。
timeout: 60s

# 打印每个 HTTP 请求，排查 401 / 403 时用。
verbose: false

# ---------- 以下都有默认值，按需打开 ----------
# 不迁移集群级绑定（CRTB）。默认迁移，并把集群级角色分摊到该集群的每个绑定组里。
# skipClusterGrants: false
# 绑定组的成员 / 命名空间按计划全量覆盖（默认与 AeroLink 里的既有配置取并集）。
# 打开会顶掉管理员手工加进去的成员，慎用。
# replaceMembers: false
# replaceNamespaces: false
# 把限定对象名（resourceNames）的规则放宽到整个资源类型。默认跳过，因为放宽等于提权。
# widenResourceNames: false
# 把 Rancher 拉到的原始数据落到该目录，便于核对字段；之后可用 fromDir 离线复跑。
# dumpDir: ""
# 不从 Rancher 拉数据，改从该目录读导出的集合 JSON（此时 rancher.url / token 可以留空）。
# fromDir: ""
# 把计划写成 JSON 文件，便于评审与留档。
# planOut: ""
`

// legacyFlagNames 是退役的 -kite-* 参数名 → 新的 -aerolink-* 名。老脚本与既有笔记还在用它们，
// 解析前统一把名字改回去，-help 里就只用列新名。
var legacyFlagNames = map[string]string{
	"kite-url":      "aerolink-url",
	"kite-token":    "aerolink-token",
	"kite-insecure": "aerolink-insecure",
}

// normalizeLegacyFlagNames 把参数里的退役名字换成新名。-kite-url 值、-kite-url=值、--kite-url=值
// 三种写法都只改名字部分，取参方式仍由 flag 包决定。
func normalizeLegacyFlagNames(args []string) []string {
	normalized := make([]string, len(args))
	for index, arg := range args {
		normalized[index] = arg
		if arg == "" || arg[0] != '-' {
			continue
		}
		name, value, hasValue := strings.Cut(arg, "=")
		trimmed := strings.TrimLeft(name, "-")
		replacement, ok := legacyFlagNames[trimmed]
		if !ok {
			continue
		}
		renamed := name[:len(name)-len(trimmed)] + replacement
		if hasValue {
			renamed += "=" + value
		}
		normalized[index] = renamed
	}
	return normalized
}

// parseFlags 解析命令行。返回值里 cli 只带命令行上显式给出的值，
// set 记录哪些参数是显式给出的（flag 包只在显式给出时才 Set）。
func parseFlags(args []string) (options, map[string]bool, error) {
	args = normalizeLegacyFlagNames(args)
	fs := flag.NewFlagSet("rancherrbac", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	fs.Usage = func() {
		out := fs.Output()
		_, _ = fmt.Fprint(out, "把 Rancher 上的项目 / 集群授权迁移成 AeroLink 的权限绑定组。\n"+
			"默认只读：只打印计划，不写任何东西；确认无误后加 -apply。\n\n"+
			"用法：\n"+
			"  rancherrbac -config rancherrbac.yaml                # 用配置文件（推荐）\n"+
			"  rancherrbac -config rancherrbac.yaml -apply         # 确认计划后落库\n"+
			"  rancherrbac -init-config rancherrbac.yaml           # 先生成一份配置模板\n"+
			"  rancherrbac -aerolink-url ... -aerolink-token ...   # 也可以全部走命令行\n\n"+
			"退役的旧名仍可用（与新名同时给出时以新名为准）：\n"+
			"  -kite-url / -kite-token / -kite-insecure、环境变量 KITE_URL / KITE_TOKEN、\n"+
			"  配置文件的 kite: 段落。\n\n"+
			"参数（命令行 > 环境变量 > 配置文件 > 默认值）：\n")
		fs.PrintDefaults()
	}

	var cli options
	fs.StringVar(&cli.configPath, "config", "",
		"配置文件路径（YAML 或 JSON）；不传时按 $"+configEnvVar+"、再按当前目录的 rancherrbac.yaml/.yml/.json 找")
	fs.StringVar(&cli.initConfig, "init-config", "",
		"生成一份带注释的配置模板到该路径，然后退出；文件已存在时拒绝覆盖")
	fs.BoolVar(&cli.showVersion, "version", false, "打印版本号并退出")

	fs.StringVar(&cli.rancherURL, "rancher-url", "",
		"Rancher 地址，例如 https://rancher.example.com（默认取 $RANCHER_URL）")
	fs.StringVar(&cli.rancherToken, "rancher-token", "",
		"Rancher API 密钥，形如 token-xxxxx:yyyyy（默认取 $RANCHER_TOKEN）")
	fs.BoolVar(&cli.rancherInsecure, "rancher-insecure", false, "跳过 Rancher 的 TLS 证书校验")
	fs.StringVar(&cli.kiteURL, "aerolink-url", "",
		"AeroLink 地址，例如 https://aerolink.example.com（默认取 $AEROLINK_URL；旧名 -kite-url / $KITE_URL 仍可用）")
	fs.StringVar(&cli.kiteToken, "aerolink-token", "",
		"AeroLink API key，即控制台里的 kite<id>-<secret>（默认取 $AEROLINK_TOKEN；旧名 -kite-token / $KITE_TOKEN 仍可用）")
	fs.BoolVar(&cli.kiteInsecure, "aerolink-insecure", false, "跳过 AeroLink 的 TLS 证书校验（旧名 -kite-insecure 仍可用）")

	fs.BoolVar(&cli.apply, "apply", false, "真正写入 AeroLink；不加则只打印计划（dry-run）")
	fs.StringVar(&cli.planOut, "plan-out", "", "把计划写成 JSON 文件，便于评审")
	fs.StringVar(&cli.dumpDir, "dump-dir", "", "把 Rancher 拉到的原始数据落到该目录，便于核对字段")
	fs.StringVar(&cli.fromDir, "from-dir", "",
		"不从 Rancher 拉数据，改从该目录读预先导出的集合 JSON（文件名与 -dump-dir 一致；此时不需要 rancher.url / token）")
	fs.StringVar(&cli.prefix, "prefix", "",
		"角色名与绑定组名的前缀（默认空：直接用 Rancher 上的角色模板名与项目名）")
	fs.StringVar(&cli.namespacesSource, "namespaces-source", "",
		"读取命名空间归属的接口：auto / v1（Steve /v1/namespaces）/ v3（Norman /v3/namespaces）")
	fs.BoolVar(&cli.skipClusterGrants, "skip-cluster-grants", false,
		"不迁移集群级绑定（CRTB）；默认迁移，并把它分摊到该集群的每个权限绑定组")
	fs.BoolVar(&cli.replaceMembers, "replace-members", false,
		"权限绑定组成员按计划全量覆盖（默认与既有成员取并集）")
	fs.BoolVar(&cli.replaceNamespaces, "replace-namespaces", false,
		"权限绑定组命名空间按计划全量覆盖（默认与既有命名空间取并集）")
	fs.BoolVar(&cli.widenResourceNames, "widen-resource-names", false,
		"把限定对象名（resourceNames）的规则放宽到整个资源类型；默认跳过，因为放宽等于提权")
	fs.Var(&cli.clusterMaps, "cluster-map", "Rancher 集群 ID → AeroLink 集群名，例如 c-m-abc123=prod（可重复）")
	fs.Var(&cli.userMaps, "user-map", "Rancher 用户名 → AeroLink 用户名，例如 bob=robert（可重复）")
	fs.Var(&cli.groupMaps, "group-map", "Rancher 用户组 → AeroLink 用户组，例如 devs=developers（可重复）")
	fs.DurationVar(&cli.timeout, "timeout", 0, "单个 HTTP 请求的超时时间")
	fs.BoolVar(&cli.verbose, "v", false, "打印每个 HTTP 请求，便于排查")
	fs.BoolVar(&cli.cleanup, "cleanup", false,
		"反向操作：按描述里的迁移标记删除本工具创建的角色与权限绑定组（同名手工对象跳过；需要 -yes）")
	fs.BoolVar(&cli.yes, "yes", false, "与 -cleanup 搭配，跳过确认")

	if err := fs.Parse(args); err != nil {
		return options{}, nil, err
	}
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	return cli, set, nil
}
