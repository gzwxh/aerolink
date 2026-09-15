package common

import (
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

	NodeTerminalPodName    = "kite-node-terminal-agent"
	KubectlTerminalPodName = "kite-kubectl-agent"

	KubectlAnnotation = "kubectl.kubernetes.io/last-applied-configuration"
)

var (
	// Database connection pool; overridable through KITE_DB_* environment
	// variables for MySQL/PostgreSQL deployments with different concurrency.
	DBConnMaxLifetime = 10 * time.Minute
	DBMaxOpenConns    = 100
	DBMaxIdleConns    = 10

	Port            = "8080"
	JwtSecret       = DefaultJWTSecret
	EnableAnalytics = false
	// AllowInsecureSecrets permits the built-in keys; development only.
	AllowInsecureSecrets = false
	Host                 = ""
	Base                 = ""

	// Images Kite pulls when it spawns pod/terminal/agent workloads. They are
	// mirrored in the company registry (SWR, org "dsy") so an air-gapped
	// cluster can pull them; each remains overridable via the environment or
	// the settings UI.
	NodeTerminalImage    = "swr.cn-south-1.myhuaweicloud.com/dsy/busybox:latest"
	KubectlTerminalImage = "swr.cn-south-1.myhuaweicloud.com/dsy/kubectl:latest"
	ClusterAgentImage    = "swr.cn-south-1.myhuaweicloud.com/dsy/devops/kite:latest"
	DBType               = "sqlite"
	DBDSN                = "dev.db"

	// DefaultKiteEncryptKey is only a bootstrap value for development. Secrets
	// encrypted with it are readable by anyone who has the database, so
	// production deployments must set KITE_ENCRYPT_KEY (or
	// KITE_REQUIRE_ENCRYPT_KEY=true to make that mandatory).
	DefaultKiteEncryptKey = "kite-default-encryption-key-change-in-production"
	KiteEncryptKey        = DefaultKiteEncryptKey

	AllNamespaces = "_all"

	AnonymousUserEnabled = false

	CookieExpirationSeconds = 2 * JWTExpirationSeconds // double jwt

	DisableGZIP        = true
	EnableVersionCheck = true

	// CORSAllowedOrigins is empty by default (no CORS in production).
	// Developers can set CORS_ALLOWED_ORIGINS=http://localhost:5173 for
	// local Vite dev server cross-origin requests.
	CORSAllowedOrigins []string

	// TrustedProxies controls which direct peer IPs may provide forwarding headers.
	// Set TRUSTED_PROXIES to override the defaults, or TRUSTED_PROXIES=none to
	// ignore all client-supplied forwarding headers.
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

	// ConfigFilePath is the path to the external config file (set via KITE_CONFIG_FILE env)
	ConfigFilePath = ""

	// ManagedSections tracks which configuration sections are managed by the config file.
	// Keys: "clusters", "oauth", "ldap", "rbac", "superUser"
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

func LoadEnvs() {
	// KITE_ALLOW_INSECURE_SECRETS is the single, explicit escape hatch for local
	// development; without it the built-in keys are refused outright.
	if v := os.Getenv("KITE_ALLOW_INSECURE_SECRETS"); v != "" {
		AllowInsecureSecrets = strings.EqualFold(strings.TrimSpace(v), "true")
	}

	if secret := os.Getenv("JWT_SECRET"); secret != "" {
		JwtSecret = secret
		// The general-setting layer prefers this value, so reject a weak one
		// early instead of signing sessions with it.
		if len(secret) < 32 {
			if !AllowInsecureSecrets {
				klog.Fatalf("JWT_SECRET is shorter than 32 bytes: refusing to start (use openssl rand -base64 32, or KITE_ALLOW_INSECURE_SECRETS=true for local development)")
			}
			klog.Warningf("JWT_SECRET is shorter than 32 bytes; use a longer random secret in production")
		}
	}

	if port := os.Getenv("PORT"); port != "" {
		Port = port
	}

	if analytics := os.Getenv("ENABLE_ANALYTICS"); analytics == "true" {
		EnableAnalytics = true
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

	if dbDSN := os.Getenv("DB_DSN"); dbDSN != "" {
		DBDSN = dbDSN
	}

	if dbType := os.Getenv("DB_TYPE"); dbType != "" {
		if dbType != "sqlite" && dbType != "mysql" && dbType != "postgres" {
			klog.Fatalf("Invalid DB_TYPE: %s, must be one of sqlite, mysql, postgres", dbType)
		}
		DBType = dbType
	}

	requireEncryptKey := strings.EqualFold(strings.TrimSpace(os.Getenv("KITE_REQUIRE_ENCRYPT_KEY")), "true")

	if key := os.Getenv("KITE_ENCRYPT_KEY"); key != "" {
		KiteEncryptKey = key
		if len(key) < 32 {
			klog.Warningf("KITE_ENCRYPT_KEY is shorter than 32 bytes; use a longer random value (openssl rand -base64 32)")
		}
	} else if !AllowInsecureSecrets || requireEncryptKey {
		klog.Fatalf("KITE_ENCRYPT_KEY is not set: refusing to start. Stored credentials (cluster kubeconfigs, LDAP/SMTP/OAuth passwords, AI keys) " +
			"would be encrypted with the built-in public key. Set KITE_ENCRYPT_KEY=\"$(openssl rand -base64 32)\", or for local development run " +
			"`make run` / `make dev` (they load dev.env) or set KITE_ALLOW_INSECURE_SECRETS=true.")
	} else {
		klog.Warningf("KITE_ENCRYPT_KEY is not set, using the built-in key because KITE_ALLOW_INSECURE_SECRETS=true. Never do this in production.")
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

	if v := os.Getenv("ANONYMOUS_USER_ENABLED"); v == "true" {
		AnonymousUserEnabled = true
		klog.Warningf("Anonymous user is enabled, this is not secure for production!")
	}
	if v := os.Getenv("HOST"); v != "" {
		Host = v
	}
	if v := os.Getenv("DISABLE_GZIP"); v != "" {
		DisableGZIP = v == "true"
	}

	if v := os.Getenv("DISABLE_VERSION_CHECK"); v == "true" {
		EnableVersionCheck = false
	}

	if v := os.Getenv("KITE_BASE"); v != "" {
		if v[0] != '/' {
			v = "/" + v
		}
		Base = strings.TrimRight(v, "/")
		klog.Infof("Using base path: %s", Base)
	}

	if v := os.Getenv("KITE_CONFIG_FILE"); v != "" {
		ConfigFilePath = v
	}

	if v := os.Getenv("CORS_ALLOWED_ORIGINS"); v != "" {
		origins := strings.Split(v, ",")
		for _, o := range origins {
			o = strings.TrimSpace(o)
			if o != "" {
				CORSAllowedOrigins = append(CORSAllowedOrigins, o)
			}
		}
		klog.Warningf("CORS enabled for origins: %v — disable in production", CORSAllowedOrigins)
	}

	if v := os.Getenv("TRUSTED_PROXIES"); v != "" {
		TrustedProxies = nil
		if !strings.EqualFold(strings.TrimSpace(v), "none") {
			proxies := strings.Split(v, ",")
			for _, proxy := range proxies {
				proxy = strings.TrimSpace(proxy)
				if proxy != "" {
					TrustedProxies = append(TrustedProxies, proxy)
				}
			}
		}
	}
	klog.Infof("Trusted proxies configured: %v", TrustedProxies)
}
