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
		_ = os.Unsetenv("KITE_DB_MAX_OPEN_CONNS")
		_ = os.Unsetenv("KITE_DB_MAX_IDLE_CONNS")
		_ = os.Unsetenv("KITE_DB_CONN_MAX_LIFETIME_MINUTES")
	})

	// The encryption/JWT secrets have their own hard checks; this test only
	// exercises the pool variables, so keep the insecure escape hatch on.
	t.Setenv("KITE_ALLOW_INSECURE_SECRETS", "true")

	t.Setenv("KITE_DB_MAX_OPEN_CONNS", "250")
	t.Setenv("KITE_DB_MAX_IDLE_CONNS", "25")
	t.Setenv("KITE_DB_CONN_MAX_LIFETIME_MINUTES", "30")
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

	// Invalid values must be ignored instead of breaking startup.
	t.Setenv("KITE_DB_MAX_OPEN_CONNS", "abc")
	t.Setenv("KITE_DB_MAX_IDLE_CONNS", "-1")
	t.Setenv("KITE_DB_CONN_MAX_LIFETIME_MINUTES", "-5")
	LoadEnvs()

	if DBMaxOpenConns != 250 {
		t.Errorf("invalid KITE_DB_MAX_OPEN_CONNS must be ignored, got %d", DBMaxOpenConns)
	}
	if DBMaxIdleConns != 25 {
		t.Errorf("invalid KITE_DB_MAX_IDLE_CONNS must be ignored, got %d", DBMaxIdleConns)
	}
	if DBConnMaxLifetime != 30*time.Minute {
		t.Errorf("invalid KITE_DB_CONN_MAX_LIFETIME_MINUTES must be ignored, got %s", DBConnMaxLifetime)
	}

	// Zero idle connections is a legitimate setting, not an invalid value.
	t.Setenv("KITE_DB_MAX_IDLE_CONNS", "0")
	LoadEnvs()
	if DBMaxIdleConns != 0 {
		t.Errorf("KITE_DB_MAX_IDLE_CONNS=0 must be applied, got %d", DBMaxIdleConns)
	}
}
