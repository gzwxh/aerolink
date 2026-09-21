package audit

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/zxh326/kite/pkg/model"
	"k8s.io/klog/v2"
)

// GetAuditSetting 返回审计章节的配置：保留策略 + syslog 外发。
//
// 路由：GET /api/v1/admin/audit-setting（需 settings.audit 的读权限）
func GetAuditSetting(c *gin.Context) {
	setting, err := model.GetAuditSetting()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load audit setting: " + err.Error()})
		return
	}
	// 通道开关由 sink 推导（五者互斥）：这里给界面看的是**真实生效值**，
	// 而不是库里可能残留的旧意向值（升级前存下的 archive.enabled=true 之类）。
	setting.ApplySinkExclusivity()
	maskAuditSecrets(setting)
	c.JSON(http.StatusOK, gin.H{
		"setting": setting,
		// sink 是**启动期由配置文件决定**的审计落地方式（database | parquet | elasticsearch |
		// victorialogs | openobserve），运行期不变，所以界面只读展示、不提供修改入口。放在响应顶层
		// 而不是 setting 里，是为了明确它不是数据库里那份可改的配置。
		"sink": model.AuditSink,
		// 保留天数对 victorialogs / openobserve **不生效**（过期由服务端配置决定，客户端没有删除
		// 接口）：界面必须据此明说，否则管理员会以为自己设的天数在生效。
		"retentionServerSide":  model.AuditSinkRetentionIsServerSide(),
		"minRetentionDays":     model.MinAuditRetentionDays,
		"recommendedRetention": recommendedRetentionDays,
	})
}

// secretMask 是密钥回显时的占位符：读取时用它替换真实值，保存时若收到它则保留库中原值。
const secretMask = "********"

// probeTimeout 是保存配置后「连通性自检」的超时。
//
// 保存是同步请求，探测不能拖太久；10 秒足够覆盖「地址填错 / 认证不对 / 证书有问题」这几类
// 最需要当场暴露的问题。
const probeTimeout = 10 * time.Second

// maskAuditSecrets 在返回给界面前把归档密钥替换成掩码，避免明文经 API 下发到浏览器。
func maskAuditSecrets(setting *model.AuditSettingData) {
	if setting.Archive.S3.SecretKey != "" {
		setting.Archive.S3.SecretKey = secretMask
	}
	if setting.Archive.Elasticsearch.Password != "" {
		setting.Archive.Elasticsearch.Password = secretMask
	}
	if setting.Archive.OpenObserve.Password != "" {
		setting.Archive.OpenObserve.Password = secretMask
	}
}

// restoreMaskedSecrets 在保存前把掩码占位符还原为库中已存的值：
// 管理员没动密钥（回显的还是掩码）时不能把它覆盖成字面量 "********"。
//
// current 由调用方传入而不是在这里重新查库：调用方（UpdateAuditSetting）本来就要读一次
// 当前配置，重复查询既浪费又可能读到两次之间的中间状态。
func restoreMaskedSecrets(req *model.AuditSettingData, current *model.AuditSettingData) {
	if req.Archive.S3.SecretKey == secretMask {
		req.Archive.S3.SecretKey = current.Archive.S3.SecretKey
	}
	if req.Archive.Elasticsearch.Password == secretMask {
		req.Archive.Elasticsearch.Password = current.Archive.Elasticsearch.Password
	}
	if req.Archive.OpenObserve.Password == secretMask {
		req.Archive.OpenObserve.Password = current.Archive.OpenObserve.Password
	}
}

// rejectStaleSecretAfterMove 拦住「换了存储地址、密钥却还是上次回显的掩码」这种保存。
//
// 为什么必须拦住：回显是掩码、保存时收到掩码就沿用库里的旧值——这在「只改保留天数」这类场景
// 是对的，但一旦**存储地址**（endpoint / bucket / access key）也变了，沿用旧密钥几乎必然是错的：
// 请求会一路签名失败，直到运行时才在日志里暴露（实测踩到过：S3 上传报
// "The Signature you specified is invalid"，而管理员在页面上完全看不出配置有问题）。
// 与其让一个已经指向 A 存储的地址配上 B 存储的密钥，不如当场报错让管理员重填。
//
// 注意**开关**（Enabled）的变化不算「换存储」：开启/关闭 S3 不该被要求重填密钥。
func rejectStaleSecretAfterMove(req, current *model.AuditSettingData) error {
	if req.Archive.S3.SecretKey == secretMask && s3TargetChanged(req.Archive.S3, current.Archive.S3) {
		return errors.New("the S3 endpoint / bucket / access key changed: please re-enter the secret key " +
			"(a masked value cannot be carried over to another storage)")
	}
	if req.Archive.Elasticsearch.Password == secretMask && esTargetChanged(req.Archive.Elasticsearch, current.Archive.Elasticsearch) {
		return errors.New("the Elasticsearch address / username changed: please re-enter the password " +
			"(a masked value cannot be carried over to another cluster)")
	}
	if req.Archive.OpenObserve.Password == secretMask && ooTargetChanged(req.Archive.OpenObserve, current.Archive.OpenObserve) {
		return errors.New("the OpenObserve organization / address / username changed: please re-enter the password " +
			"(a masked value cannot be carried over to another deployment)")
	}
	return nil
}

// s3TargetChanged 判断 S3 的**访问目标**是否变化（开关与归档策略不算）。
func s3TargetChanged(next, current model.S3Archive) bool {
	return next.Endpoint != current.Endpoint ||
		next.Region != current.Region ||
		next.Bucket != current.Bucket ||
		next.AccessKey != current.AccessKey ||
		next.PathStyle != current.PathStyle ||
		next.UseTLS != current.UseTLS ||
		next.Prefix != current.Prefix
}

// esTargetChanged 判断 ES 的**访问目标**是否变化（开关与索引前缀之外的策略不算）。
func esTargetChanged(next, current model.ESArchive) bool {
	return !slices.Equal(next.URLs, current.URLs) ||
		next.Username != current.Username ||
		next.TLSInsecureSkipVerify != current.TLSInsecureSkipVerify
}

// ooTargetChanged 判断 OpenObserve 的**访问目标**是否变化（开关与流名之外的策略不算）。
func ooTargetChanged(next, current model.OpenObserveArchive) bool {
	return !slices.Equal(next.URLs, current.URLs) ||
		next.Org != current.Org ||
		next.Username != current.Username ||
		next.TLSInsecureSkipVerify != current.TLSInsecureSkipVerify
}

// probeArchiveTargets 在保存后主动访问一次目标存储，把「这份配置到底能不能用」当场告诉管理员。
//
// 探测失败**不阻止保存**：网络抖动、对端临时维护都可能让探测失败，而配置本身是对的；
// 所以结果只作为 warning 返回给界面，由管理员判断要不要复查。
func probeArchiveTargets(setting *model.AuditSettingData) []string {
	warnings := make([]string, 0, 2)
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()

	// 只探测**当前 sink 会用到**的通道：互斥下另外几条开关不生效，探测它们只会给出误导性的告警。
	if model.AuditSinkUsesParquet() && setting.Archive.S3.Enabled {
		if sink, err := NewS3Sink(setting.Archive.S3); err != nil {
			warnings = append(warnings, "s3: "+err.Error())
		} else if _, err := sink.ListKeys(ctx, ""); err != nil {
			// 用「列前缀」而不是「上传一个探针对象」：只读操作不需要写权限、也不在桶里留垃圾。
			warnings = append(warnings, "s3: cannot list the bucket: "+err.Error())
		}
	}
	if model.AuditSinkUsesElasticsearch() {
		if sink, err := NewESSink(setting.Archive.Elasticsearch); err != nil {
			warnings = append(warnings, "elasticsearch: "+err.Error())
		} else if err := sink.Ping(ctx); err != nil {
			warnings = append(warnings, "elasticsearch: "+err.Error())
		}
	}
	if model.AuditSinkUsesVictoriaLogs() {
		if sink, err := NewVictoriaLogsSink(setting.Archive.VictoriaLogs); err != nil {
			warnings = append(warnings, "victorialogs: "+err.Error())
		} else if err := sink.Ping(ctx); err != nil {
			warnings = append(warnings, "victorialogs: "+err.Error())
		}
	}
	if model.AuditSinkUsesOpenObserve() {
		if sink, err := NewOpenObserveSink(setting.Archive.OpenObserve); err != nil {
			warnings = append(warnings, "openobserve: "+err.Error())
		} else if err := sink.Ping(ctx); err != nil {
			warnings = append(warnings, "openobserve: "+err.Error())
		}
	}
	return warnings
}

// recommendedRetentionDays 是等保 /《网络安全法》通常核查的最低保留期（不少于 6 个月）。
// 它是提示值而非下限：下限由 model.MinAuditRetentionDays 强制。
const recommendedRetentionDays = 180

// UpdateAuditSetting 保存审计配置。
//
// 路由：PUT /api/v1/admin/audit-setting（需 settings.audit 的写权限）
//
// 这是审计管理员唯一能"改"的东西：保留策略与归档/外发配置。审计记录本身仍然只能读
// （没有任何手工删除接口），删除只可能由保留策略按时间自动滚动发生，且每次都留痕。
func UpdateAuditSetting(c *gin.Context) {
	var req model.AuditSettingData
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	current, err := model.GetAuditSetting()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to load audit setting: " + err.Error()})
		return
	}

	// 第一道闸：换了存储却沿用掩码密钥——直接拒绝，而不是静默保留一个必然错误的密钥。
	if err := rejectStaleSecretAfterMove(&req, current); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	restoreMaskedSecrets(&req, current)

	setting, err := model.UpdateAuditSetting(req)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// 保留策略 / 外发地址一变，外发器要立即按新配置工作。
	reloadSyslogConfig()
	// 标准输出的开关与格式同样热生效。
	reloadStdoutConfig()
	// 归档位置 / S3/ES 参数同样热生效（关闭时停掉运行时）。
	reloadArchiveConfig()

	// 归档存储配置的变更单独留痕（管理接口本身的那条记录看不出"改了什么"）。
	recordArchiveSettingChange(c, current, setting)

	response := gin.H{"setting": setting}
	// 第二道闸：主动探一次目标存储，把问题当场反馈，而不是等归档真的跑起来才发现。
	if warnings := probeArchiveTargets(setting); len(warnings) > 0 {
		klog.Warningf("audit archive settings saved with connectivity problems: %v", warnings)
		response["warnings"] = warnings
	}
	c.JSON(http.StatusOK, response)
}

// recordArchiveSettingChange 给归档存储配置的变更单独留一条审计记录。
//
// 管理接口的写操作本来就会被审计中间件记一条（`system/audit-setting`），但那条只有「改过审计
// 设置」这个粒度，看不出**改了什么**、更看不出密钥有没有被动过。归档是审计数据的出口，出口
// 地址被改掉是最需要被追溯的动作之一，所以这里额外记一条带摘要的记录。
//
// 摘要写进 `resource_yaml`：它默认不进 parquet、也不进检索用的结构化字段，正适合放这种
// 又长又只是给人看的文本。密钥只记「是否变更」（changed / unchanged），绝不留明文。
func recordArchiveSettingChange(c *gin.Context, before, after *model.AuditSettingData) {
	summary := archiveSettingDiff(*before, *after)
	if summary == "" {
		return
	}

	// 到这里说明配置确实变了，operator 一定存在（能写这个接口就有身份）；取不到就不记，
	// 宁可不记也不要写一条没有主体的审计记录。
	user, ok := c.Get("user")
	if !ok {
		return
	}
	operator, ok := user.(model.User)
	if !ok || operator.ID == 0 {
		return
	}

	history := model.ResourceHistory{
		ResourceType:    "system/audit-archive",
		ResourceName:    "archive-settings",
		OperationType:   "update",
		OperationSource: "manual",
		Success:         true,
		ClientIP:        c.ClientIP(),
		OperatorID:      model.OperatorRef(operator.ID),
		OperatorName:    operator.Username,
		ResourceYAML:    model.LongText(summary),
	}
	if err := model.RecordAudit(c.Request.Context(), &history); err != nil {
		klog.Errorf("failed to record the archive setting change: %v", err)
	}
}

// archiveSettingDiff 生成归档相关配置的变更摘要；没有实质变化时返回空串。
//
// 比较的是**归档出口**（S3 / ES / 本地目录 / 开关），不含保留天数与攒批参数：那些是调优项，
// 变了不值得单独留一条记录，管理接口的通用审计已经覆盖。
func archiveSettingDiff(before, after model.AuditSettingData) string {
	lines := make([]string, 0, 8)

	changed := func(field, oldValue, newValue string) {
		if oldValue != newValue {
			lines = append(lines, fmt.Sprintf("%s: %s -> %s", field, dashIfEmpty(oldValue), dashIfEmpty(newValue)))
		}
	}
	changedBool := func(field string, oldValue, newValue bool) {
		if oldValue != newValue {
			lines = append(lines, fmt.Sprintf("%s: %t -> %t", field, oldValue, newValue))
		}
	}

	changedBool("archive.enabled", before.Archive.Enabled, after.Archive.Enabled)
	changed("archive.localDir", before.Archive.LocalDir, after.Archive.LocalDir)

	// S3：地址类字段记原值，密钥只记是否变更。
	changedBool("s3.enabled", before.Archive.S3.Enabled, after.Archive.S3.Enabled)
	changed("s3.endpoint", before.Archive.S3.Endpoint, after.Archive.S3.Endpoint)
	changed("s3.region", before.Archive.S3.Region, after.Archive.S3.Region)
	changed("s3.bucket", before.Archive.S3.Bucket, after.Archive.S3.Bucket)
	changed("s3.accessKey", before.Archive.S3.AccessKey, after.Archive.S3.AccessKey)
	changed("s3.prefix", before.Archive.S3.Prefix, after.Archive.S3.Prefix)
	changedBool("s3.pathStyle", before.Archive.S3.PathStyle, after.Archive.S3.PathStyle)
	changedBool("s3.useTLS", before.Archive.S3.UseTLS, after.Archive.S3.UseTLS)
	changedBool("s3.deleteLocalAfterUpload", before.Archive.S3.DeleteLocalAfterUpload, after.Archive.S3.DeleteLocalAfterUpload)
	if before.Archive.S3.SecretKey != after.Archive.S3.SecretKey {
		lines = append(lines, "s3.secretKey: changed")
	}

	// ES：同理，密码只记是否变更。
	changedBool("es.enabled", before.Archive.Elasticsearch.Enabled, after.Archive.Elasticsearch.Enabled)
	changed("es.urls", strings.Join(before.Archive.Elasticsearch.URLs, ","), strings.Join(after.Archive.Elasticsearch.URLs, ","))
	changed("es.username", before.Archive.Elasticsearch.Username, after.Archive.Elasticsearch.Username)
	changed("es.indexPrefix", before.Archive.Elasticsearch.IndexPrefix, after.Archive.Elasticsearch.IndexPrefix)
	if before.Archive.Elasticsearch.Password != after.Archive.Elasticsearch.Password {
		lines = append(lines, "es.password: changed")
	}

	// VictoriaLogs / OpenObserve：同样只记地址类字段与「密码是否变更」。
	changedBool("victorialogs.enabled", before.Archive.VictoriaLogs.Enabled, after.Archive.VictoriaLogs.Enabled)
	changed("victorialogs.urls", strings.Join(before.Archive.VictoriaLogs.URLs, ","), strings.Join(after.Archive.VictoriaLogs.URLs, ","))
	changed("victorialogs.stream", before.Archive.VictoriaLogs.Stream, after.Archive.VictoriaLogs.Stream)
	changed("victorialogs.accountId", before.Archive.VictoriaLogs.AccountID, after.Archive.VictoriaLogs.AccountID)
	changed("victorialogs.projectId", before.Archive.VictoriaLogs.ProjectID, after.Archive.VictoriaLogs.ProjectID)

	changedBool("openobserve.enabled", before.Archive.OpenObserve.Enabled, after.Archive.OpenObserve.Enabled)
	changed("openobserve.urls", strings.Join(before.Archive.OpenObserve.URLs, ","), strings.Join(after.Archive.OpenObserve.URLs, ","))
	changed("openobserve.org", before.Archive.OpenObserve.Org, after.Archive.OpenObserve.Org)
	changed("openobserve.stream", before.Archive.OpenObserve.Stream, after.Archive.OpenObserve.Stream)
	changed("openobserve.username", before.Archive.OpenObserve.Username, after.Archive.OpenObserve.Username)
	if before.Archive.OpenObserve.Password != after.Archive.OpenObserve.Password {
		lines = append(lines, "openobserve.password: changed")
	}

	return strings.Join(lines, "\n")
}

// dashIfEmpty 让空值在摘要里显示成 "-"，避免出现 "bucket:  -> foo" 这种读不出所以然的行。
func dashIfEmpty(value string) string {
	if strings.TrimSpace(value) == "" {
		return "-"
	}
	return value
}
