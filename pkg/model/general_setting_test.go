package model

import (
	"sync"
	"testing"
	"time"

	"github.com/zxh326/kite/pkg/common"
)

func TestDefaultGeneralNodeTerminalImageValue(t *testing.T) {
	original := common.NodeTerminalImage
	t.Cleanup(func() {
		common.NodeTerminalImage = original
	})

	common.NodeTerminalImage = "  custom/node-terminal:1.0  "
	if got := DefaultGeneralNodeTerminalImageValue(); got != "custom/node-terminal:1.0" {
		t.Fatalf("DefaultGeneralNodeTerminalImageValue() = %q, want %q", got, "custom/node-terminal:1.0")
	}

	common.NodeTerminalImage = "   "
	if got := DefaultGeneralNodeTerminalImageValue(); got != DefaultGeneralNodeTerminalImage {
		t.Fatalf("DefaultGeneralNodeTerminalImageValue() = %q, want %q", got, DefaultGeneralNodeTerminalImage)
	}
}

func TestNormalizeGeneralAIProvider(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"anthropic", " Anthropic ", GeneralAIProviderAnthropic},
		{"openai", "OPENAI", GeneralAIProviderOpenAI},
		{"unknown", "something-else", GeneralAIProviderOpenAI},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := NormalizeGeneralAIProvider(tt.input); got != tt.expected {
				t.Fatalf("NormalizeGeneralAIProvider() = %q, want %q", got, tt.expected)
			}
		})
	}
}

func TestIsGeneralAIProviderSupported(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  bool
	}{
		{"openai", "openai", true},
		{"anthropic", " Anthropic ", true},
		{"unknown", "gemini", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsGeneralAIProviderSupported(tt.input); got != tt.want {
				t.Fatalf("IsGeneralAIProviderSupported() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestDefaultGeneralAIModelByProvider(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"anthropic", GeneralAIProviderAnthropic, DefaultGeneralAnthropicModel},
		{"openai", GeneralAIProviderOpenAI, DefaultGeneralAIModel},
		{"unknown", "anything else", DefaultGeneralAIModel},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := DefaultGeneralAIModelByProvider(tt.input); got != tt.expected {
				t.Fatalf("DefaultGeneralAIModelByProvider() = %q, want %q", got, tt.expected)
			}
		})
	}
}

func TestApplyRuntimeGeneralSetting(t *testing.T) {
	originalAnalytics := common.EnableAnalytics.Load()
	originalVersionCheck := common.EnableVersionCheck.Load()
	t.Cleanup(func() {
		common.EnableAnalytics.Store(originalAnalytics)
		common.EnableVersionCheck.Store(originalVersionCheck)
	})

	applyRuntimeGeneralSetting(&GeneralSetting{
		EnableAnalytics:    true,
		EnableVersionCheck: false,
	})

	if !common.EnableAnalytics.Load() {
		t.Fatalf("EnableAnalytics = %v, want true", common.EnableAnalytics.Load())
	}
	if common.EnableVersionCheck.Load() {
		t.Fatalf("EnableVersionCheck = %v, want false", common.EnableVersionCheck.Load())
	}

	applyRuntimeGeneralSetting(nil)
	if !common.EnableAnalytics.Load() {
		t.Fatalf("nil setting changed EnableAnalytics")
	}
	if common.EnableVersionCheck.Load() {
		t.Fatalf("nil setting changed EnableVersionCheck")
	}
}

// 环境变量显式指定过的开关不能被通用设置改写：内网部署靠它压住向外发请求的
// 行为，只让数据库说了算的话 DISABLE_VERSION_CHECK 之类的变量形同虚设。
func TestApplyRuntimeGeneralSettingRespectsEnvOverride(t *testing.T) {
	originalAnalytics := common.EnableAnalytics.Load()
	originalVersionCheck := common.EnableVersionCheck.Load()
	t.Cleanup(func() {
		common.EnableAnalytics.Store(originalAnalytics)
		common.EnableVersionCheck.Store(originalVersionCheck)
	})

	t.Setenv("DISABLE_VERSION_CHECK", "true")
	t.Setenv("ENABLE_ANALYTICS", "false")
	// 模拟 LoadEnvs 已按环境变量应用：两个开关都关着。
	common.EnableAnalytics.Store(false)
	common.EnableVersionCheck.Store(false)

	// 数据库里是历史值（都开着），环境变量必须压过它。
	applyRuntimeGeneralSetting(&GeneralSetting{
		EnableAnalytics:    true,
		EnableVersionCheck: true,
	})

	if common.EnableAnalytics.Load() {
		t.Fatalf("EnableAnalytics = true, want it left false by ENABLE_ANALYTICS=false")
	}
	if common.EnableVersionCheck.Load() {
		t.Fatalf("EnableVersionCheck = true, want it left false by DISABLE_VERSION_CHECK=true")
	}
}

// 这两个开关既在被请求路径读取（安全响应头、版本检查、index.html 注入），
// 又在通用设置写入时被改写——而且 applyRuntimeGeneralSetting 会随
// GetGeneralSetting 一起跑，登录、RBAC、终端等路径都会触发它，因此读写是真的会并发。
//
// 修复前它们是普通包级 bool，下面这段并发读写用 `go test -race ./pkg/model/`
// 就会报数据竞争；现在必须是原子量才能通过。
func TestApplyRuntimeGeneralSettingIsSafeUnderConcurrentReads(t *testing.T) {
	originalAnalytics := common.EnableAnalytics.Load()
	originalVersionCheck := common.EnableVersionCheck.Load()
	t.Cleanup(func() {
		common.EnableAnalytics.Store(originalAnalytics)
		common.EnableVersionCheck.Store(originalVersionCheck)
	})

	const readers = 4
	var wg sync.WaitGroup
	started := make(chan struct{}, readers)
	stop := make(chan struct{})
	for i := 0; i < readers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			started <- struct{}{}
			for {
				select {
				case <-stop:
					return
				default:
					_ = common.EnableAnalytics.Load()
					_ = common.EnableVersionCheck.Load()
				}
			}
		}()
	}
	// 等读者真正跑起来再写：否则写循环可能在它们被调度之前就结束，
	// 竞争窗口根本没出现（用固定次数的写循环就会这样漏掉）。
	for i := 0; i < readers; i++ {
		<-started
	}

	deadline := time.Now().Add(100 * time.Millisecond)
	for i := 0; time.Now().Before(deadline); i++ {
		applyRuntimeGeneralSetting(&GeneralSetting{
			EnableAnalytics:    i%2 == 0,
			EnableVersionCheck: i%2 == 1,
		})
	}
	close(stop)
	wg.Wait()

	// 并发阶段结束后再写一组确定的值，断言不受最后一次并发写入影响。
	applyRuntimeGeneralSetting(&GeneralSetting{EnableAnalytics: false, EnableVersionCheck: true})
	if common.EnableAnalytics.Load() {
		t.Error("EnableAnalytics = true, want false")
	}
	if !common.EnableVersionCheck.Load() {
		t.Error("EnableVersionCheck = false, want true")
	}
}

func TestEnsureJWTSecret(t *testing.T) {
	originalJWTSecret := common.JwtSecret
	t.Cleanup(func() {
		common.JwtSecret = originalJWTSecret
	})

	t.Run("configured secret wins", func(t *testing.T) {
		common.JwtSecret = "configured-secret"
		setting := GeneralSetting{JWTSecret: SecretString("stored-secret")}
		updates := map[string]interface{}{}

		if err := ensureJWTSecret(&setting, updates); err != nil {
			t.Fatalf("ensureJWTSecret() error = %v", err)
		}
		if setting.JWTSecret != SecretString("configured-secret") {
			t.Fatalf("setting.JWTSecret = %q, want %q", setting.JWTSecret, "configured-secret")
		}
		if common.JwtSecret != "configured-secret" {
			t.Fatalf("common.JwtSecret = %q, want %q", common.JwtSecret, "configured-secret")
		}
		if got := updates["jwt_secret"]; got != SecretString("configured-secret") {
			t.Fatalf("updates[jwt_secret] = %#v, want %#v", got, SecretString("configured-secret"))
		}
	})

	t.Run("stored secret is reused when config uses default", func(t *testing.T) {
		common.JwtSecret = common.DefaultJWTSecret
		setting := GeneralSetting{JWTSecret: SecretString("stored-secret")}

		if err := ensureJWTSecret(&setting, nil); err != nil {
			t.Fatalf("ensureJWTSecret() error = %v", err)
		}
		if setting.JWTSecret != SecretString("stored-secret") {
			t.Fatalf("setting.JWTSecret = %q, want %q", setting.JWTSecret, "stored-secret")
		}
		if common.JwtSecret != "stored-secret" {
			t.Fatalf("common.JwtSecret = %q, want %q", common.JwtSecret, "stored-secret")
		}
	})

	t.Run("generates secret when neither source is set", func(t *testing.T) {
		common.JwtSecret = common.DefaultJWTSecret
		setting := GeneralSetting{}
		updates := map[string]interface{}{}

		if err := ensureJWTSecret(&setting, updates); err != nil {
			t.Fatalf("ensureJWTSecret() error = %v", err)
		}
		if setting.JWTSecret == "" {
			t.Fatal("setting.JWTSecret is empty")
		}
		if setting.JWTSecret == SecretString(common.DefaultJWTSecret) {
			t.Fatalf("setting.JWTSecret = %q, want generated secret", setting.JWTSecret)
		}
		if common.JwtSecret != string(setting.JWTSecret) {
			t.Fatalf("common.JwtSecret = %q, want %q", common.JwtSecret, setting.JWTSecret)
		}
		if got := updates["jwt_secret"]; got != setting.JWTSecret {
			t.Fatalf("updates[jwt_secret] = %#v, want %#v", got, setting.JWTSecret)
		}
	})
}
