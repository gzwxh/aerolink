package common

import (
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"k8s.io/klog/v2"
)

const (
	JWTExpirationSeconds = 24 * 60 * 60 // 24 hours
	DefaultJWTSecret     = "kite-default-jwt-secret-key-change-in-production"

	NodeTerminalPodName    = "aerolink-node-terminal-agent"
	KubectlTerminalPodName = "aerolink-kubectl-agent"

	KubectlAnnotation = "kubectl.kubernetes.io/last-applied-configuration"
)

var (
	// 数据库连接池；可通过 AEROLINK_DB_* 环境变量覆盖，
	// 以适应并发量不同的 MySQL/PostgreSQL 部署。
	DBConnMaxLifetime = 10 * time.Minute
	DBMaxOpenConns    = 100
	DBMaxIdleConns    = 10

	Port      = "8080"
	JwtSecret = DefaultJWTSecret
	// AllowInsecureSecrets 允许使用内置密钥；仅限开发环境。
	AllowInsecureSecrets = false
	Host                 = ""
	Base                 = ""

	// Kite 在创建 pod/终端/agent 工作负载时拉取的镜像。它们
	// 已镜像到公司仓库（SWR，组织 "gzwxh"），以便隔离网络
	// 的集群也能拉取；每个都仍可通过环境变量或
	// 设置界面覆盖。
	NodeTerminalImage    = "swr.cn-south-1.myhuaweicloud.com/gzwxh/busybox:latest"
	KubectlTerminalImage = "swr.cn-south-1.myhuaweicloud.com/gzwxh/kubectl:latest"
	ClusterAgentImage    = "swr.cn-south-1.myhuaweicloud.com/gzwxh/devops/aerolink:latest"
	DBType               = "sqlite"
	DBDSN                = "dev.db"

	// DefaultKiteEncryptKey 只是开发用的引导值。用它加密的
	// 密钥，任何拿到数据库的人都能解密，因此
	// 生产部署必须设置 AEROLINK_ENCRYPT_KEY（或
	// 设置 AEROLINK_REQUIRE_ENCRYPT_KEY=true 使其成为强制要求）。
	DefaultKiteEncryptKey = "kite-default-encryption-key-change-in-production"
	KiteEncryptKey        = DefaultKiteEncryptKey

	AllNamespaces = "_all"

	AnonymousUserEnabled = false

	CookieExpirationSeconds = 2 * JWTExpirationSeconds // double jwt

	DisableGZIP = true

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

	// ConfigFilePath 是外部配置文件的路径（通过 AEROLINK_CONFIG_FILE 环境变量设置）
	ConfigFilePath = ""

	// AuditArchiveDir 是审计/访问日志的本地归档目录（AEROLINK_AUDIT_ARCHIVE_DIR）。
	// 只作启动兜底：审计设置里的 Archive.LocalDir 优先（见 pkg/model/audit_setting.go）。
	AuditArchiveDir = ""

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
func LoadEnvs() {
	loadSecretEnvs()
	loadDatabaseEnvs()
	loadServerEnvs()
	loadRuntimeEnvs()
}

// loadSecretEnvs 先读秘钥类配置：后面的组会用到 AllowInsecureSecrets，
// 所以它必须排在最前面。
func loadSecretEnvs() {
	// AEROLINK_ALLOW_INSECURE_SECRETS 是本地开发唯一且显式的逃生开关；
	// 不开启时内置密钥会被直接拒绝。
	if v := Getenv("ALLOW_INSECURE_SECRETS"); v != "" {
		AllowInsecureSecrets = strings.EqualFold(strings.TrimSpace(v), "true")
	}

	if secret := os.Getenv("JWT_SECRET"); secret != "" {
		JwtSecret = secret
		// 通用设置层会优先采用这个值，因此要尽早拒绝弱密钥，
		// 而不是用它去签发会话。
		if len(secret) < 32 {
			if !AllowInsecureSecrets {
				klog.Fatalf("JWT_SECRET is shorter than 32 bytes: refusing to start (use openssl rand -base64 32, or AEROLINK_ALLOW_INSECURE_SECRETS=true for local development)")
			}
			klog.Warningf("JWT_SECRET is shorter than 32 bytes; use a longer random secret in production")
		}
	}

	if key := Getenv("ENCRYPT_KEY"); key != "" {
		KiteEncryptKey = key
		if len(key) < 32 {
			klog.Warningf("AEROLINK_ENCRYPT_KEY is shorter than 32 bytes; use a longer random value (openssl rand -base64 32)")
		}
	} else if requireEncryptKey() || !AllowInsecureSecrets {
		klog.Fatalf("AEROLINK_ENCRYPT_KEY is not set: refusing to start. Stored credentials (cluster kubeconfigs, LDAP/SMTP/OAuth passwords, AI keys) " +
			"would be encrypted with the built-in public key. Set AEROLINK_ENCRYPT_KEY=\"$(openssl rand -base64 32)\", or for local development run " +
			"`make run` / `make dev` (they load dev.env) or set AEROLINK_ALLOW_INSECURE_SECRETS=true.")
	} else {
		klog.Warningf("AEROLINK_ENCRYPT_KEY is not set, using the built-in key because AEROLINK_ALLOW_INSECURE_SECRETS=true. Never do this in production.")
	}
}

// requireEncryptKey 表示“即使处于本地开发模式也必须提供 AEROLINK_ENCRYPT_KEY”。
func requireEncryptKey() bool {
	return strings.EqualFold(strings.TrimSpace(Getenv("REQUIRE_ENCRYPT_KEY")), "true")
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

	if v := Getenv("DB_MAX_OPEN_CONNS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			DBMaxOpenConns = n
		} else {
			klog.Warningf("Invalid AEROLINK_DB_MAX_OPEN_CONNS %q, keeping %d", v, DBMaxOpenConns)
		}
	}
	if v := Getenv("DB_MAX_IDLE_CONNS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			DBMaxIdleConns = n
		} else {
			klog.Warningf("Invalid AEROLINK_DB_MAX_IDLE_CONNS %q, keeping %d", v, DBMaxIdleConns)
		}
	}
	if v := Getenv("DB_CONN_MAX_LIFETIME_MINUTES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			DBConnMaxLifetime = time.Duration(n) * time.Minute
		} else {
			klog.Warningf("Invalid AEROLINK_DB_CONN_MAX_LIFETIME_MINUTES %q, keeping %s", v, DBConnMaxLifetime)
		}
	}

	// PostgreSQL 的 DSN 没有 MySQL 那样的默认值兜底（见 model.MySQLDSN）：漏写 TimeZone
	// 不会报错，但 timestamptz 会按服务端时区解释（官方镜像默认 Etc/UTC），界面与审计
	// 日志里的时间会整体偏移。这里只告警、不改写 DSN——静默改时区比报错更难定位。
	if warn := postgresDSNTimeZoneWarning(DBType, DBDSN); warn != "" {
		klog.Warningf("%s", warn)
	}
}

// postgresDSNTimeZoneWarning 报告 PostgreSQL 的 DSN 是否漏写了 TimeZone，漏则返回告警文案。
//
// 只查这一项是刻意的：DSN 里其它参数漏了通常症状很直接（连不上、读写报错），
// 而时区漏了不报错，只让时间静默偏移——这类问题最难在事后定位。
func postgresDSNTimeZoneWarning(dbType, dsn string) string {
	if dbType != "postgres" || dsnHasTimeZone(dsn) {
		return ""
	}
	return `DB_DSN does not set TimeZone for PostgreSQL: timestamptz values are interpreted in the server's time zone ` +
		`(the official image defaults to Etc/UTC), so timestamps in the UI and audit logs shift by that offset. ` +
		`Add it to DB_DSN, e.g. TimeZone=Asia/Shanghai, or ?TimeZone=Asia%2FShanghai in the URL form.`
}

// dsnHasTimeZone 在两种 DSN 写法里找 timezone 参数（大小写不敏感，pgx 两种都支持）。
func dsnHasTimeZone(dsn string) bool {
	if strings.Contains(dsn, "://") {
		u, err := url.Parse(dsn)
		if err != nil {
			return false
		}
		query := u.Query()
		for key := range query {
			if strings.EqualFold(key, "timezone") {
				return true
			}
		}
		// 也认 options=-c timezone=... 这种写法。
		return strings.Contains(strings.ToLower(query.Get("options")), "timezone")
	}
	for _, field := range strings.Fields(dsn) {
		if key, _, ok := strings.Cut(field, "="); ok && strings.EqualFold(key, "timezone") {
			return true
		}
	}
	return false
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
	if v := Getenv("BASE"); v != "" {
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
	if v := Getenv("CONFIG_FILE"); v != "" {
		ConfigFilePath = v
	}
	if v := Getenv("AUDIT_ARCHIVE_DIR"); v != "" {
		AuditArchiveDir = strings.TrimSpace(v)
	}
}
