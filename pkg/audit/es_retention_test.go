package audit

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/zxh326/kite/pkg/model"
)

// fakeESIndices 是一个只认「列索引 / 删索引」的假 ES：把请求记下来，按预置的索引列表回答。
type fakeESIndices struct {
	server   *httptest.Server
	listed   []string // _cat/indices 返回的索引名
	listPath string   // 最近一次列索引的请求路径（带查询串）
	deleted  []string // 收到的 DELETE 目标索引
	listErr  bool     // 列索引时返回 404（索引一个都还没有）
	deleteSt map[string]int
}

func newFakeESIndices(t *testing.T, indices ...string) *fakeESIndices {
	t.Helper()
	fake := &fakeESIndices{listed: indices, deleteSt: map[string]int{}}
	fake.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Elastic-Product", "Elasticsearch")
		w.Header().Set("Content-Type", "application/json")

		if r.Method == http.MethodDelete {
			name := strings.TrimPrefix(r.URL.Path, "/")
			fake.deleted = append(fake.deleted, name)
			if status := fake.deleteSt[name]; status != 0 {
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"error":{"type":"index_not_found_exception"}}`))
				return
			}
			_, _ = w.Write([]byte(`{"acknowledged":true}`))
			return
		}

		fake.listPath = r.URL.Path + "?" + r.URL.RawQuery
		if fake.listErr {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"error":{"type":"index_not_found_exception"}}`))
			return
		}
		rows := make([]string, 0, len(fake.listed))
		for _, name := range fake.listed {
			rows = append(rows, `{"index":"`+name+`"}`)
		}
		_, _ = w.Write([]byte("[" + strings.Join(rows, ",") + "]"))
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func (f *fakeESIndices) sink(t *testing.T) *ESSink {
	t.Helper()
	sink, err := NewESSink(model.ESArchive{
		Enabled:     true,
		URLs:        []string{f.server.URL},
		IndexPrefix: "aerolink-audit",
	})
	if err != nil {
		t.Fatalf("NewESSink() error = %v", err)
	}
	return sink
}

// 按天索引的删除粒度是「整天」：只有整天的数据都过期才删，且只删认得出来的本应用索引。
func TestESSinkDeleteIndicesBefore(t *testing.T) {
	fake := newFakeESIndices(t,
		"aerolink-audit-2026.06.01", // 整天早于截止时间
		"aerolink-audit-2026.07.02", // 一天结束正好等于截止时间（整天已过期，属边界）
		"aerolink-audit-2026.07.03", // 截止时间所在的那天：还有记录在保留期内
		"aerolink-audit-2026.09.20", // 还在保留期内
		"other-app-2026.06.01",      // 不是本应用的索引
		"aerolink-audit-not-a-day",  // 后缀不是日期
	)
	now := time.Date(2026, 9, 21, 0, 0, 0, 0, time.Local)
	cutoff := now.AddDate(0, 0, -80) // 正好是 2026-07-03 00:00

	deleted, err := fake.sink(t).DeleteIndicesBefore(context.Background(), cutoff)
	if err != nil {
		t.Fatalf("DeleteIndicesBefore() error = %v", err)
	}

	sort.Strings(deleted)
	want := []string{"aerolink-audit-2026.06.01", "aerolink-audit-2026.07.02"}
	if strings.Join(deleted, ",") != strings.Join(want, ",") {
		t.Errorf("deleted = %v, want %v", deleted, want)
	}

	// 列索引要按前缀通配、并带上 json 格式；被关掉的索引也要能列出来（否则磁盘回收不了）。
	if !strings.Contains(fake.listPath, "_cat/indices/aerolink-audit-*") ||
		!strings.Contains(fake.listPath, "format=json") ||
		!strings.Contains(fake.listPath, "open%2Cclosed") {
		t.Errorf("_cat/indices request = %q, want the prefix pattern, json format and open,closed", fake.listPath)
	}
}

// 索引一个都还没有（ES 还没写过）是正常状态：既不该报错，也不该发出任何删除请求。
func TestESSinkDeleteIndicesBeforeWithoutIndices(t *testing.T) {
	fake := newFakeESIndices(t)
	fake.listErr = true

	deleted, err := fake.sink(t).DeleteIndicesBefore(context.Background(), time.Now())
	if err != nil {
		t.Fatalf("索引为空时不该报错, got %v", err)
	}
	if len(deleted) != 0 || len(fake.deleted) != 0 {
		t.Errorf("deleted = %v (requests %v), want nothing", deleted, fake.deleted)
	}
}

// 多副本下同一个索引可能被另一个副本先删掉：那说明目标已达成，不能当成失败。
func TestESSinkDeleteIndicesBeforeToleratesAlreadyDeletedIndex(t *testing.T) {
	fake := newFakeESIndices(t, "aerolink-audit-2026.01.01")
	fake.deleteSt["aerolink-audit-2026.01.01"] = http.StatusNotFound

	deleted, err := fake.sink(t).DeleteIndicesBefore(context.Background(), time.Now())
	if err != nil {
		t.Fatalf("已被删除的索引不该报错, got %v", err)
	}
	if len(deleted) != 1 || deleted[0] != "aerolink-audit-2026.01.01" {
		t.Errorf("deleted = %v, want the already-gone index to count as deleted", deleted)
	}
}

// 一个索引删失败不能拖累其它索引（否则一个权限问题会让保留策略整体停摆）。
func TestESSinkDeleteIndicesBeforeKeepsGoingAfterFailure(t *testing.T) {
	fake := newFakeESIndices(t, "aerolink-audit-2026.01.01", "aerolink-audit-2026.01.02")
	fake.deleteSt["aerolink-audit-2026.01.01"] = http.StatusForbidden

	deleted, err := fake.sink(t).DeleteIndicesBefore(context.Background(), time.Now())
	if err == nil {
		t.Fatal("被拒绝的删除必须作为错误返回，而不是静默吞掉")
	}
	if len(deleted) != 1 || deleted[0] != "aerolink-audit-2026.01.02" {
		t.Errorf("deleted = %v, want the second index to be deleted anyway", deleted)
	}
}

// 四类记录共用按天索引，删除粒度是整天：保留期取审计与访问日志里更长的那个，宁多留不少留。
func TestESIndexRetentionDays(t *testing.T) {
	cases := []struct {
		audit, access, want int
	}{
		{90, 3, 90},
		{90, 120, 120},
		{180, 180, 180},
		{365, 0, 365},
	}
	for _, tc := range cases {
		setting := model.DefaultAuditSettingData()
		setting.RetentionDays = tc.audit
		setting.Archive.AccessLog.RetentionDays = tc.access

		if got := esIndexRetentionDays(&setting); got != tc.want {
			t.Errorf("esIndexRetentionDays(audit=%d, access=%d) = %d, want %d",
				tc.audit, tc.access, got, tc.want)
		}
	}
}
