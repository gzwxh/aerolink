package common

import (
	"os"
	"testing"
	"time"
)

func TestLoadEnvsDatabasePool(t *testing.T) {
	previousOpen, previousIdle, previousLifetime := DBMaxOpenConns, DBMaxIdleConns, DBConnMaxLifetime
	t.Cleanup(func() {
		DBMaxOpenConns, DBMaxIdleConns, DBConnMaxLifetime = previousOpen, previousIdle, previousLifetime
		_ = os.Unsetenv("AEROLINK_DB_MAX_OPEN_CONNS")
		_ = os.Unsetenv("AEROLINK_DB_MAX_IDLE_CONNS")
		_ = os.Unsetenv("AEROLINK_DB_CONN_MAX_LIFETIME_MINUTES")
	})

	// 加密/JWT 密钥有自己的硬性校验；本测试只
	// 覆盖连接池相关变量，因此保持不安全逃生开关开启。
	t.Setenv("AEROLINK_ALLOW_INSECURE_SECRETS", "true")

	t.Setenv("AEROLINK_DB_MAX_OPEN_CONNS", "250")
	t.Setenv("AEROLINK_DB_MAX_IDLE_CONNS", "25")
	t.Setenv("AEROLINK_DB_CONN_MAX_LIFETIME_MINUTES", "30")
	LoadEnvs()

	if DBMaxOpenConns != 250 {
		t.Errorf("DBMaxOpenConns = %d, want 250", DBMaxOpenConns)
	}
	if DBMaxIdleConns != 25 {
		t.Errorf("DBMaxIdleConns = %d, want 25", DBMaxIdleConns)
	}
	if DBConnMaxLifetime != 30*time.Minute {
		t.Errorf("DBConnMaxLifetime = %s, want 30m", DBConnMaxLifetime)
	}

	// 非法值必须被忽略，而不是让启动失败。
	t.Setenv("AEROLINK_DB_MAX_OPEN_CONNS", "abc")
	t.Setenv("AEROLINK_DB_MAX_IDLE_CONNS", "-1")
	t.Setenv("AEROLINK_DB_CONN_MAX_LIFETIME_MINUTES", "-5")
	LoadEnvs()

	if DBMaxOpenConns != 250 {
		t.Errorf("invalid AEROLINK_DB_MAX_OPEN_CONNS must be ignored, got %d", DBMaxOpenConns)
	}
	if DBMaxIdleConns != 25 {
		t.Errorf("invalid AEROLINK_DB_MAX_IDLE_CONNS must be ignored, got %d", DBMaxIdleConns)
	}
	if DBConnMaxLifetime != 30*time.Minute {
		t.Errorf("invalid AEROLINK_DB_CONN_MAX_LIFETIME_MINUTES must be ignored, got %s", DBConnMaxLifetime)
	}

	// 空闲连接数为 0 是合法配置，不是非法值。
	t.Setenv("AEROLINK_DB_MAX_IDLE_CONNS", "0")
	LoadEnvs()
	if DBMaxIdleConns != 0 {
		t.Errorf("AEROLINK_DB_MAX_IDLE_CONNS=0 must be applied, got %d", DBMaxIdleConns)
	}
}
