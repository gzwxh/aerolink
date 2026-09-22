package common

import (
	"reflect"
	"testing"
)

func TestLoadEnvs(t *testing.T) {
	old := struct {
		JwtSecret            string
		Port                 string
		AgentPodNamespace    string
		NodeTerminalImage    string
		KubectlTerminalImage string
		DBDSN                string
		DBType               string
		EncryptKey           string
		AnonymousUserEnabled bool
		Host                 string
		DisableGZIP          bool
		Base                 string
		CORSAllowedOrigins   []string
		TrustedProxies       []string
	}{
		JwtSecret:            JwtSecret,
		Port:                 Port,
		AgentPodNamespace:    AgentPodNamespace,
		NodeTerminalImage:    NodeTerminalImage,
		KubectlTerminalImage: KubectlTerminalImage,
		DBDSN:                DBDSN,
		DBType:               DBType,
		EncryptKey:           EncryptKey,
		AnonymousUserEnabled: AnonymousUserEnabled,
		Host:                 Host,
		DisableGZIP:          DisableGZIP,
		Base:                 Base,
		CORSAllowedOrigins:   append([]string(nil), CORSAllowedOrigins...),
		TrustedProxies:       append([]string(nil), TrustedProxies...),
	}
	defer func() {
		JwtSecret = old.JwtSecret
		Port = old.Port
		AgentPodNamespace = old.AgentPodNamespace
		NodeTerminalImage = old.NodeTerminalImage
		KubectlTerminalImage = old.KubectlTerminalImage
		DBDSN = old.DBDSN
		DBType = old.DBType
		EncryptKey = old.EncryptKey
		AnonymousUserEnabled = old.AnonymousUserEnabled
		Host = old.Host
		DisableGZIP = old.DisableGZIP
		Base = old.Base
		CORSAllowedOrigins = append([]string(nil), old.CORSAllowedOrigins...)
		TrustedProxies = append([]string(nil), old.TrustedProxies...)
	}()

	CORSAllowedOrigins = nil
	TrustedProxies = nil

	t.Setenv("JWT_SECRET", "test-jwt-secret-with-32-bytes-min!!")
	t.Setenv("PORT", "9090")
	t.Setenv("NAMESPACE", "test-namespace")
	t.Setenv("NODE_TERMINAL_IMAGE", "test-node-image")
	t.Setenv("KUBECTL_TERMINAL_IMAGE", "test-kubectl-image")
	t.Setenv("CLUSTER_AGENT_IMAGE", "test-cluster-agent-image")
	t.Setenv("DB_DSN", "test.db")
	t.Setenv("DB_TYPE", "mysql")
	t.Setenv("AEROLINK_ENCRYPT_KEY", "test-encrypt-key")
	t.Setenv("ANONYMOUS_USER_ENABLED", "true")
	t.Setenv("HOST", "example.com")
	t.Setenv("DISABLE_GZIP", "false")
	t.Setenv("AEROLINK_BASE", "aerolink/")
	t.Setenv("CORS_ALLOWED_ORIGINS", "http://localhost:5173, https://example.com ,,")
	t.Setenv("TRUSTED_PROXIES", "10.42.0.0/16, 192.0.2.10 ,, ")

	LoadEnvs()

	if JwtSecret != "test-jwt-secret-with-32-bytes-min!!" {
		t.Fatalf("JwtSecret = %q, want %q", JwtSecret, "test-jwt-secret-with-32-bytes-min!!")
	}
	if Port != "9090" {
		t.Fatalf("Port = %q, want %q", Port, "9090")
	}
	if AgentPodNamespace != "test-namespace" {
		t.Fatalf("AgentPodNamespace = %q, want %q", AgentPodNamespace, "test-namespace")
	}
	if NodeTerminalImage != "test-node-image" {
		t.Fatalf("NodeTerminalImage = %q, want %q", NodeTerminalImage, "test-node-image")
	}
	if KubectlTerminalImage != "test-kubectl-image" {
		t.Fatalf("KubectlTerminalImage = %q, want %q", KubectlTerminalImage, "test-kubectl-image")
	}
	if DBDSN != "test.db" {
		t.Fatalf("DBDSN = %q, want %q", DBDSN, "test.db")
	}
	if DBType != "mysql" {
		t.Fatalf("DBType = %q, want %q", DBType, "mysql")
	}
	if EncryptKey != "test-encrypt-key" {
		t.Fatalf("EncryptKey = %q, want %q", EncryptKey, "test-encrypt-key")
	}
	if !AnonymousUserEnabled {
		t.Fatalf("AnonymousUserEnabled = %v, want true", AnonymousUserEnabled)
	}
	if Host != "example.com" {
		t.Fatalf("Host = %q, want %q", Host, "example.com")
	}
	if DisableGZIP {
		t.Fatalf("DisableGZIP = %v, want false", DisableGZIP)
	}
	if Base != "/aerolink" {
		t.Fatalf("Base = %q, want %q", Base, "/aerolink")
	}

	wantOrigins := []string{"http://localhost:5173", "https://example.com"}
	if !reflect.DeepEqual(CORSAllowedOrigins, wantOrigins) {
		t.Fatalf("CORSAllowedOrigins = %#v, want %#v", CORSAllowedOrigins, wantOrigins)
	}

	wantTrustedProxies := []string{"10.42.0.0/16", "192.0.2.10"}
	if !reflect.DeepEqual(TrustedProxies, wantTrustedProxies) {
		t.Fatalf("TrustedProxies = %#v, want %#v", TrustedProxies, wantTrustedProxies)
	}
}

func TestLoadEnvs_BaseAlreadyHasLeadingSlash(t *testing.T) {
	old := struct {
		EncryptKey         string
		Base               string
		CORSAllowedOrigins []string
	}{
		EncryptKey:         EncryptKey,
		Base:               Base,
		CORSAllowedOrigins: append([]string(nil), CORSAllowedOrigins...),
	}
	defer func() {
		EncryptKey = old.EncryptKey
		Base = old.Base
		CORSAllowedOrigins = append([]string(nil), old.CORSAllowedOrigins...)
	}()

	t.Setenv("AEROLINK_ENCRYPT_KEY", "test-encrypt-key")
	t.Setenv("AEROLINK_BASE", "/aerolink/")

	LoadEnvs()

	if Base != "/aerolink" {
		t.Fatalf("Base = %q, want %q", Base, "/aerolink")
	}
}
