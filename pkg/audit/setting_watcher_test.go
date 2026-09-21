package audit

import (
	"context"
	"testing"
	"time"

	"github.com/zxh326/kite/pkg/model"
)

// 多副本下改设置只有 1/N 个副本生效，是「配了没生效」的一类；收敛靠内容指纹。
//
// 判据用内存里的访问日志格式：它由 reloadArchiveConfig 从库里读出来设置，只要重载发生
// 就会被库里的值覆盖。先人为扰动一下，就能区分「重载了」与「没重载」。
func TestConvergeAuditSettingOnlyReloadsWhenChanged(t *testing.T) {
	setupRetentionTestDB(t)
	if _, err := model.GetAuditSetting(); err != nil {
		t.Fatalf("seeding the default setting: %v", err)
	}
	t.Cleanup(func() {
		SetAccessLogFormat(model.LogFormatText)
		appliedSettingRevision.Store(nil)
	})

	markAuditSettingApplied()

	// 指纹没变：不该重载，人为扰动要保留下来。
	SetAccessLogFormat(model.LogFormatJSON)
	convergeAuditSetting()
	if got := CurrentAccessLogFormat(); got != model.LogFormatJSON {
		t.Errorf("指纹未变时不该重载（内存态被覆盖了）: %q", got)
	}

	// 库里的设置变了：必须重载，扰动被库里的值（text）覆盖。
	setting, err := model.GetAuditSetting()
	if err != nil {
		t.Fatalf("GetAuditSetting() error = %v", err)
	}
	setting.Archive.AccessLog.Format = model.LogFormatText
	if _, err := model.UpdateAuditSetting(*setting); err != nil {
		t.Fatalf("UpdateAuditSetting() error = %v", err)
	}

	convergeAuditSetting()
	if got := CurrentAccessLogFormat(); got != model.LogFormatText {
		t.Errorf("指纹变了必须重载到库里的值: %q", got)
	}

	// 收敛之后指纹已被记下：再扰动一次，下一次轮询不该又重载。
	SetAccessLogFormat(model.LogFormatJSON)
	convergeAuditSetting()
	if got := CurrentAccessLogFormat(); got != model.LogFormatJSON {
		t.Errorf("收敛后不该重复重载: %q", got)
	}
}

// 保存设置的那个副本自己有记录指纹（UpdateAuditSetting 里调 markAuditSettingApplied），
// 否则它会在下一轮把同一份配置再重载一遍（归档运行时被无谓重建）。
func TestMarkAuditSettingAppliedPreventsRedundantReload(t *testing.T) {
	setupRetentionTestDB(t)
	if _, err := model.GetAuditSetting(); err != nil {
		t.Fatalf("seeding the default setting: %v", err)
	}
	t.Cleanup(func() {
		SetAccessLogFormat(model.LogFormatText)
		appliedSettingRevision.Store(nil)
	})

	markAuditSettingApplied()
	SetAccessLogFormat(model.LogFormatJSON)
	convergeAuditSetting()

	if got := CurrentAccessLogFormat(); got != model.LogFormatJSON {
		t.Errorf("标记过指纹后不该重载: %q", got)
	}
}

// 轮询本体：tick 到了会收敛，ctx 取消后退出（不能泄漏 goroutine）。
func TestRunSettingWatchLoopConvergesAndStops(t *testing.T) {
	setupRetentionTestDB(t)
	if _, err := model.GetAuditSetting(); err != nil {
		t.Fatalf("seeding the default setting: %v", err)
	}
	t.Cleanup(func() {
		SetAccessLogFormat(model.LogFormatText)
		appliedSettingRevision.Store(nil)
	})

	// 指纹为空 + 内存态被人为扰动：第一次 tick 就应该把它改回库里的 text。
	appliedSettingRevision.Store(nil)
	SetAccessLogFormat(model.LogFormatJSON)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		runSettingWatchLoop(ctx, 5*time.Millisecond)
		close(done)
	}()

	deadline := time.Now().Add(2 * time.Second)
	for CurrentAccessLogFormat() != model.LogFormatText && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	converged := CurrentAccessLogFormat()

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ctx 取消后轮询没有退出")
	}

	if converged != model.LogFormatText {
		t.Errorf("轮询没有收敛到库里的值: %q", converged)
	}
}
