package common

import (
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"k8s.io/klog/v2"
)

const (
	JWTExpirationSeconds = 24 * 60 * 60 // 24 hours
	DefaultJWTSecret     = "kite-default-jwt-secret-key-change-in-production"

	NodeTerminalPodName    = "kite-node-terminal-agent"
	KubectlTerminalPodName = "kite-kubectl-agent"

	KubectlAnnotation = "kubectl.kubernetes.io/last-applied-configuration"
)

var (
	// 数据库连接池；可通过 KITE_DB_* 环境变量覆盖，
	// 以适应并发量不同的 MySQL/PostgreSQL 部署。
	DBConnMaxLifetime = 10 * time.Minute
	DBMaxOpenConns    = 100
	DBMaxIdleConns    = 10

	Port      = "8080"
	JwtSecret = DefaultJWTSecret
	// EnableAnalytics / EnableVersionCheck 会在运行时被通用设置改写
	// （model.applyRuntimeGeneralSetting 会随 GetGeneralSetting 一起跑），
	// 同时又被请求路径读取（安全响应头、版本检查、index.html 注入），
	// 因此必须是原子量：普通 bool 在这里是会被 -race 抓到的数据竞争。
	EnableAnalytics atomic.Bool
	// AllowInsecureSecrets 允许使用内置密钥；仅限开发环境。
	AllowInsecureSecrets = false
	Host                 = ""
	Base                 = ""

	// Kite 在创建 pod/终端/agent 工作负载时拉取的镜像。它们
	// 已镜像到公司仓库（SWR，组织 "dsy"），以便隔离网络
	// 的集群也能拉取；每个都仍可通过环境变量或
	// 设置界面覆盖。
	NodeTerminalImage    = "swr.cn-south-1.myhuaweicloud.com/dsy/busybox:latest"
	KubectlTerminalImage = "swr.cn-south-1.myhuaweicloud.com/dsy/kubectl:latest"
	ClusterAgentImage    = "swr.cn-south-1.myhuaweicloud.com/dsy/devops/kite:latest"
	DBType               = "sqlite"
	DBDSN                = "dev.db"

	// DefaultKiteEncryptKey 只是开发用的引导值。用它加密的
	// 密钥，任何拿到数据库的人都能解密，因此
	// 生产部署必须设置 KITE_ENCRYPT_KEY（或
	// 设置 KITE_REQUIRE_ENCRYPT_KEY=true 使其成为强制要求）。
	DefaultKiteEncryptKey = "kite-default-encryption-key-change-in-production"
	KiteEncryptKey        = DefaultKiteEncryptKey

	AllNamespaces = "_all"

	AnonymousUserEnabled = false

	CookieExpirationSeconds = 2 * JWTExpirationSeconds // double jwt

	DisableGZIP        = true
	EnableVersionCheck atomic.Bool

	// CORSAllowedOrigins 默认为空（生产环境不需要 CORS）。
	// 开发者可以设置 CORS_ALLOWED_ORIGINS=http://localhost:5173，
	// 以便本地 Vite dev server 发起跨域请求。
	CORSAllowedOrigins []string

	// TrustedProxies 控制哪些直连对端 IP 可以提供转发头。
	// 设置 TRUSTED_PROXIES 覆盖默认值，或设为 TRUSTED_PROXIES=none
	// 以忽略所有客户端提供的转发头。
	TrustedProxies = []string{
		"127.0.0.0/8",
		"10.0.0.0/8",
		"172.16.0.0/12",
		"192.168.0.0/16",
		"::1",
		"fc00::/7",
	}

	APIKeyProvider = "api_key"

	AgentPodNamespace = "kube-system"

	// ConfigFilePath 是外部配置文件的路径（通过 KITE_CONFIG_FILE 环境变量设置）
	ConfigFilePath = ""

	// ManagedSections 记录哪些配置分区由配置文件管理。
	// Key 取值："clusters"、"oauth"、"ldap"、"rbac"、"superUser"
	ManagedSections = map[string]bool{}
	managedMu       sync.RWMutex
)

const ManagedSectionError = "This section is managed by configuration file and cannot be modified through the UI"

func IsSectionManaged(section string) bool {
	managedMu.RLock()
	defer managedMu.RUnlock()
	return ManagedSections[section]
}

func SetManagedSections(sections map[string]bool) {
	managedMu.Lock()
	defer managedMu.Unlock()

	ManagedSections = make(map[string]bool, len(sections))
	for section, managed := range sections {
		if managed {
			ManagedSections[section] = true
		}
	}
}

// LoadEnvs 读取全部环境变量配置。
//
// 按用途拆成几组小函数：原来的单个大函数分支数过多，加一个环境变量就得重新数
// 复杂度；分组后每组只关心一类配置，也更容易对照文档逐个核对。
func init() {
	// 与原先非原子变量的默认值保持一致：版本检查默认开启。
	EnableVersionCheck.Store(true)
}

func LoadEnvs() {
	loadSecretEnvs()
	loadDatabaseEnvs()
	loadServerEnvs()
	loadRuntimeEnvs()
}

// loadSecretEnvs 先读秘钥类配置：后面的组会用到 AllowInsecureSecrets，
// 所以它必须排在最前面。
func loadSecretEnvs() {
	// KITE_ALLOW_INSECURE_SECRETS 是本地开发唯一且显式的逃生开关；
	// 不开启时内置密钥会被直接拒绝。
	if v := os.Getenv("KITE_ALLOW_INSECURE_SECRETS"); v != "" {
		AllowInsecureSecrets = strings.EqualFold(strings.TrimSpace(v), "true")
	}

	if secret := os.Getenv("JWT_SECRET"); secret != "" {
		JwtSecret = secret
		// 通用设置层会优先采用这个值，因此要尽早拒绝弱密钥，
		// 而不是用它去签发会话。
		if len(secret) < 32 {
			if !AllowInsecureSecrets {
				klog.Fatalf("JWT_SECRET is shorter than 32 bytes: refusing to start (use openssl rand -base64 32, or KITE_ALLOW_INSECURE_SECRETS=true for local development)")
			}
			klog.Warningf("JWT_SECRET is shorter than 32 bytes; use a longer random secret in production")
		}
	}

	if key := os.Getenv("KITE_ENCRYPT_KEY"); key != "" {
		KiteEncryptKey = key
		if len(key) < 32 {
			klog.Warningf("KITE_ENCRYPT_KEY is shorter than 32 bytes; use a longer random value (openssl rand -base64 32)")
		}
	} else if requireEncryptKey() || !AllowInsecureSecrets {
		klog.Fatalf("KITE_ENCRYPT_KEY is not set: refusing to start. Stored credentials (cluster kubeconfigs, LDAP/SMTP/OAuth passwords, AI keys) " +
			"would be encrypted with the built-in public key. Set KITE_ENCRYPT_KEY=\"$(openssl rand -base64 32)\", or for local development run " +
			"`make run` / `make dev` (they load dev.env) or set KITE_ALLOW_INSECURE_SECRETS=true.")
	} else {
		klog.Warningf("KITE_ENCRYPT_KEY is not set, using the built-in key because KITE_ALLOW_INSECURE_SECRETS=true. Never do this in production.")
	}
}

// requireEncryptKey 表示“即使处于本地开发模式也必须提供 KITE_ENCRYPT_KEY”。
func requireEncryptKey() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv("KITE_REQUIRE_ENCRYPT_KEY")), "true")
}

// loadDatabaseEnvs 读取数据库连接与连接池配置。
func loadDatabaseEnvs() {
	if dbDSN := os.Getenv("DB_DSN"); dbDSN != "" {
		DBDSN = dbDSN
	}

	if dbType := os.Getenv("DB_TYPE"); dbType != "" {
		if dbType != "sqlite" && dbType != "mysql" && dbType != "postgres" {
			klog.Fatalf("Invalid DB_TYPE: %s, must be one of sqlite, mysql, postgres", dbType)
		}
		DBType = dbType
	}

	if v := os.Getenv("KITE_DB_MAX_OPEN_CONNS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			DBMaxOpenConns = n
		} else {
			klog.Warningf("Invalid KITE_DB_MAX_OPEN_CONNS %q, keeping %d", v, DBMaxOpenConns)
		}
	}
	if v := os.Getenv("KITE_DB_MAX_IDLE_CONNS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			DBMaxIdleConns = n
		} else {
			klog.Warningf("Invalid KITE_DB_MAX_IDLE_CONNS %q, keeping %d", v, DBMaxIdleConns)
		}
	}
	if v := os.Getenv("KITE_DB_CONN_MAX_LIFETIME_MINUTES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			DBConnMaxLifetime = time.Duration(n) * time.Minute
		} else {
			klog.Warningf("Invalid KITE_DB_CONN_MAX_LIFETIME_MINUTES %q, keeping %s", v, DBConnMaxLifetime)
		}
	}
}

// loadServerEnvs 读取监听、反向代理与本地化相关配置。
func loadServerEnvs() {
	if port := os.Getenv("PORT"); port != "" {
		Port = port
	}
	if v := os.Getenv("HOST"); v != "" {
		Host = v
	}
	if v := os.Getenv("DISABLE_GZIP"); v != "" {
		DisableGZIP = v == "true"
	}
	if v := os.Getenv("DISABLE_VERSION_CHECK"); v == "true" {
		EnableVersionCheck.Store(false)
	}

	if v := os.Getenv("KITE_BASE"); v != "" {
		if v[0] != '/' {
			v = "/" + v
		}
		Base = strings.TrimRight(v, "/")
		klog.Infof("Using base path: %s", Base)
	}

	if v := os.Getenv("CORS_ALLOWED_ORIGINS"); v != "" {
		for _, origin := range strings.Split(v, ",") {
			if origin = strings.TrimSpace(origin); origin != "" {
				CORSAllowedOrigins = append(CORSAllowedOrigins, origin)
			}
		}
		klog.Warningf("CORS enabled for origins: %v — disable in production", CORSAllowedOrigins)
	}

	if v := os.Getenv("TRUSTED_PROXIES"); v != "" {
		TrustedProxies = nil
		if !strings.EqualFold(strings.TrimSpace(v), "none") {
			for _, proxy := range strings.Split(v, ",") {
				if proxy = strings.TrimSpace(proxy); proxy != "" {
					TrustedProxies = append(TrustedProxies, proxy)
				}
			}
		}
	}
	klog.Infof("Trusted proxies configured: %v", TrustedProxies)
}

// loadRuntimeEnvs 读取运行形态相关配置：命名空间、镜像、匿名访问与配置文件路径。
func loadRuntimeEnvs() {
	if analytics := os.Getenv("ENABLE_ANALYTICS"); analytics == "true" {
		EnableAnalytics.Store(true)
	}
	if ns := os.Getenv("NAMESPACE"); ns != "" {
		AgentPodNamespace = ns
	}

	if nodeTerminalImage := os.Getenv("NODE_TERMINAL_IMAGE"); nodeTerminalImage != "" {
		NodeTerminalImage = nodeTerminalImage
	}
	if kubectlTerminalImage := os.Getenv("KUBECTL_TERMINAL_IMAGE"); kubectlTerminalImage != "" {
		KubectlTerminalImage = kubectlTerminalImage
	}
	if clusterAgentImage := os.Getenv("CLUSTER_AGENT_IMAGE"); clusterAgentImage != "" {
		ClusterAgentImage = clusterAgentImage
	}

	if v := os.Getenv("ANONYMOUS_USER_ENABLED"); v == "true" {
		AnonymousUserEnabled = true
		klog.Warningf("Anonymous user is enabled, this is not secure for production!")
	}
	if v := os.Getenv("KITE_CONFIG_FILE"); v != "" {
		ConfigFilePath = v
	}
}
