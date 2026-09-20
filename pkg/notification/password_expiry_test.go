package notification

import (
	"testing"
	"time"

	"github.com/zxh326/kite/pkg/model"
)

// 密码过期提醒的口径：剩余不足一天算「还有 1 天」；已经过期就要说「已过期」。
//
// 此前判定用的是 `int(剩余小时数 / 24)`，负数向零截断，于是过期不足 24 小时会算成
// 0 天并落进「即将过期」分支，刚过期的账号收到的是「还有 1 天过期」；真正的
// 「已过期」反而只在过期 24–48 小时之间才发出。
func TestPasswordExpiryReminder(t *testing.T) {
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name      string
		expireAt  time.Time
		wantEvent string
		wantDays  string
	}{
		{"三天后", now.Add(72*time.Hour - time.Minute), model.NotificationEventPasswordExpiring, "3"},
		{"不足一天算一天", now.Add(2 * time.Hour), model.NotificationEventPasswordExpiring, "1"},
		{"正好一天", now.Add(24 * time.Hour), model.NotificationEventPasswordExpiring, "2"},
		{"窗口边界", now.Add(7 * 24 * time.Hour), model.NotificationEventPasswordExpiring, "8"},
		{"超出窗口", now.Add(8 * 24 * time.Hour), "", ""},
		{"刚过期", now.Add(-time.Minute), model.NotificationEventPasswordExpired, "0"},
		{"过期 23 小时", now.Add(-23 * time.Hour), model.NotificationEventPasswordExpired, "0"},
		{"过期一天的边界内", now.Add(-24*time.Hour + time.Minute), model.NotificationEventPasswordExpired, "0"},
		{"过期正好一天", now.Add(-24 * time.Hour), "", ""},
		{"过期超过一天", now.Add(-48 * time.Hour), "", ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			event, days, remind := passwordExpiryReminder(tc.expireAt, now, 7)
			if !remind {
				if tc.wantEvent != "" {
					t.Fatalf("no reminder sent, want event %q", tc.wantEvent)
				}
				return
			}
			if event != tc.wantEvent || days != tc.wantDays {
				t.Fatalf("reminder = %q/%s, want %q/%s", event, days, tc.wantEvent, tc.wantDays)
			}
		})
	}
}
