package model

import (
	"fmt"
	"time"

	"gorm.io/gorm"
)

// 公告级别：只决定横幅整体的强调方式（左侧色条 + 图标 + 淡底），
// 正文里的文字颜色由内容自己的具名标记决定（见 plans/2026-09-21-顶部通知栏.md §5）。
const (
	AnnouncementLevelInfo    = "info"
	AnnouncementLevelWarning = "warning"
	AnnouncementLevelDanger  = "danger"
)

// AnnouncementMaxContentLength 是正文长度上限。超限时报错而不是截断：
// 截断会让管理员以为自己写的后半段发出去了。
const AnnouncementMaxContentLength = 8192

// AnnouncementLevels 返回受支持的级别，供接口校验与界面下拉使用。
func AnnouncementLevels() []string {
	return []string{AnnouncementLevelInfo, AnnouncementLevelWarning, AnnouncementLevelDanger}
}

// IsAnnouncementLevel 报告级别是否受支持。
func IsAnnouncementLevel(level string) bool {
	for _, value := range AnnouncementLevels() {
		if value == level {
			return true
		}
	}
	return false
}

// Announcement 是管理员发布在页面顶栏的通知栏公告。
//
// 与 Notification（站内信）的差别：站内信绑定收件人、进铃铛、可标记已读；公告不绑定
// 任何用户，只按「启用 + 生效窗口」决定是否出现在所有人的横幅里，也没有已读状态。
// 公告横向滚动的三种方式。ScrollMode 取这里的值；Scroll（bool）是它的早期口径。
const (
	// AnnouncementScrollNone 不滚动：静态展示，超出部分靠拖动与「展开全文」读。
	AnnouncementScrollNone = "none"
	// AnnouncementScrollContinuous 连续滚动：一轮走完立刻接下一轮（历史行为）。
	AnnouncementScrollContinuous = "continuous"
	// AnnouncementScrollPaced 每轮走完先停一会儿再开始下一轮。
	//
	// 真机反馈：连续滚动时消息刚滑出可视区就立刻接上，长公告根本来不及读完，
	// 于是有了这个"走一轮、停一下"的口径。
	AnnouncementScrollPaced = "paced"
)

// 滚动参数（速度 / 每轮停留 / 显示时长）的默认值与允许区间。
//
// 默认值取的就是升级前写死在顶栏里的常量（60px/s、停留 2 秒、时长按内容宽度换算），
// 因此加列不需要像 scrollMode 那样回填存量数据：新建的列直接带上同样的默认值，
// 存量公告的观感一个像素都不会变。
const (
	// AnnouncementDefaultScrollSpeed 是滚动速度的默认值（像素/秒）。
	AnnouncementDefaultScrollSpeed = 60
	// AnnouncementScrollSpeedMin/Max 限定速度区间：比下限还慢看不出在动，
	// 比上限还快则完全读不了——两头都该拦在保存之前。
	AnnouncementScrollSpeedMin = 10
	AnnouncementScrollSpeedMax = 300
	// AnnouncementDefaultPauseSeconds 是「每轮停留」的默认值（秒），与历史常量一致。
	//
	// 下限是 1 而不是 0：停 0 秒等于连续滚动，那是 ScrollMode 的另一个取值。
	AnnouncementDefaultPauseSeconds = 2
	// AnnouncementPauseSecondsMax 防止一次停留久到用户以为卡住了。
	AnnouncementPauseSecondsMax = 60
	// AnnouncementDisplaySecondsMin/Max 限定「显示时长」（一轮滚完的秒数）。
	// 0 表示自动（按内容宽度与速度换算），不参与区间判断。
	AnnouncementDisplaySecondsMin = 3
	AnnouncementDisplaySecondsMax = 600
)

// IsAnnouncementScrollMode 报告取值是否为已知的滚动方式。
func IsAnnouncementScrollMode(mode string) bool {
	switch mode {
	case AnnouncementScrollNone, AnnouncementScrollContinuous, AnnouncementScrollPaced:
		return true
	default:
		return false
	}
}

// Announcement 与站内信（Notification）分两张表存储，互不共用，
// 见 plans/2026-09-21-顶部通知栏.md §3。
type Announcement struct {
	Model
	// 标题可选（空串 = 不填，横幅只显示正文）；正文必填，两者不能同时为空。
	Title    string `json:"title" gorm:"type:varchar(255);not null"`
	Content  string `json:"content" gorm:"type:text"`
	Level    string `json:"level" gorm:"type:varchar(20);not null;default:info"`
	Priority int    `json:"priority" gorm:"not null;default:0;index"`
	// Enabled 不能带 gorm 的 default 标签：GORM 对声明了 default 的字段会跳过零值，
	// 于是「新建一条停用的公告」会被数据库默认值改写成启用（users.enabled 就是这样，
	// 那边靠建号后显式回写 enabled 绕过）。这里直接把默认值去掉，靠入参决定。
	Enabled bool `json:"enabled" gorm:"type:boolean;not null;index"`
	// Scroll 决定这条公告在顶栏里是否横向滚动。
	//
	// 标签里的 `default:false` 有两个作用：SQLite 上 `ADD COLUMN ... NOT NULL` 不带默认值
	// 会直接报错（测试里真踩到过）；而且默认值取 false 恰好与「Go 零值就是 false」一致，
	// 所以 GORM「声明了 default 就跳过零值」那条规则在这里无害——显式 false 会落到 DB 的
	// 默认值 false，结果相同。**别把它改成 default:true**：那样显式设的「不滚动」会在
	// Create 时被跳过、永远存不进去（users.enabled 踩过同一个坑，见上面 Enabled 的注释）。
	//
	// 存量行加列后是 false，由 MigrateAnnouncementScrollBackfill 回填成 true。
	Scroll bool `json:"scroll" gorm:"type:boolean;not null;default:false"`
	// ScrollMode 是滚动的**方式**（none / continuous / paced，见上面的常量）。
	//
	// 与 Scroll 的关系：Scroll 是早期的布尔口径（true = 连续滚动）。保留它是为了让老客户端
	// 与已有数据仍读得懂；写入时以 ScrollMode 为准，并同步维护 `Scroll = (mode != none)`。
	// 默认 continuous 与历史行为一致：加列不会改变现有公告的观感，只有显式设过
	// scroll = false 的那些由 MigrateAnnouncementScrollModeBackfill 改成 none。
	ScrollMode string `json:"scrollMode" gorm:"type:varchar(16);not null;default:continuous"`
	// ScrollSpeed 是这条公告要求的滚动速度（像素/秒），默认 60（= 升级前写死的常量）。
	//
	// 顶栏同一时间只展示一条公告（见 DisableOtherAnnouncements），所以这里的取值
	// 就是实际生效的速度。
	//
	// 这三列都声明了 default，会被 GORM 的「有 default 就跳过零值」规则影响；
	// 但 0 在速度与停留上从来不是合法值（见上面常量区的校验区间），
	// 而 DisplaySeconds 的零值含义与默认值一致（都是「自动」），所以不会踩
	// users.enabled 那个坑。
	ScrollSpeed int `json:"scrollSpeed" gorm:"not null;default:60"`
	// PauseSeconds 是「每轮停留」的停顿时长（秒），只在 ScrollMode = paced 时生效，默认 2。
	PauseSeconds int `json:"pauseSeconds" gorm:"not null;default:2"`
	// DisplaySeconds 是一轮滚完的秒数，0 表示自动：按内容宽度与 ScrollSpeed 换算，
	// 且不短于 15 秒（见 ui/src/lib/announcement-scroll.ts）。
	//
	// 它只覆盖**滚动段**，「每轮停留」的停顿另加，两者不重叠。
	DisplaySeconds int        `json:"displaySeconds" gorm:"not null;default:0"`
	StartAt        *time.Time `json:"startAt,omitempty" gorm:"index"`
	EndAt          *time.Time `json:"endAt,omitempty" gorm:"index"`
	CreatorID      uint       `json:"creatorId" gorm:"index"`
}

func (Announcement) TableName() string {
	return "announcements"
}

// ListActiveAnnouncements 返回当前展示在顶栏的公告：已启用、已到生效时间、尚未过期。
//
// 过滤放在 SQL 里而不是取回来再挑：横幅是每个人打开页面都要读的，
// 过期与未开始的公告不该被读出来。
//
// 只取一条：通知栏同一时间只展示一条公告（写入侧由 DisableOtherAnnouncements 保证
// 只有一条启用）。这里仍然 LIMIT 1，是为了兜住旧版本留下的多条同时启用的数据——
// 取法与管理列表一致（优先级降序、同优先级取后建的）。
func ListActiveAnnouncements(now time.Time) ([]Announcement, error) {
	var items []Announcement
	err := DB.
		Where("enabled = ?", true).
		Where("start_at IS NULL OR start_at <= ?", now).
		Where("end_at IS NULL OR end_at > ?", now).
		Order("priority DESC, id DESC").
		Limit(1).
		Find(&items).Error
	return items, err
}

// ListAnnouncements 返回全部公告（含未生效、已停用、已过期），供管理界面使用。
func ListAnnouncements() ([]Announcement, error) {
	var items []Announcement
	err := DB.Order("priority DESC, id DESC").Find(&items).Error
	return items, err
}

// DisableOtherAnnouncements 停用除 keepID 之外的所有启用公告。
//
// 「同一时间有且只有一条公告启用」是写入侧的硬约束：允许存多条（备用、排期），
// 但任何一次启用都必须把其余公告停掉，不能只靠界面自觉或读取时挑一条。
func DisableOtherAnnouncements(tx *gorm.DB, keepID uint) error {
	return tx.Model(&Announcement{}).
		Where("id <> ?", keepID).
		Where("enabled = ?", true).
		Update("enabled", false).Error
}

// MigrateAnnouncementSingleEnabled 把「多条同时启用」的旧数据归一成只剩一条。
//
// 旧版本允许多条公告同时生效并串成一条轨道，现在同一时间只展示一条。保留顶栏本来
// 就会展示的那条（priority DESC, id DESC），其余改为停用——只动 enabled 标记，
// 不删除任何公告。幂等，可以每次启动都跑，顺带兜住手工改库留下的多启用状态。
func MigrateAnnouncementSingleEnabled() error {
	var keep Announcement
	if err := DB.
		Where("enabled = ?", true).
		Order("priority DESC, id DESC").
		Limit(1).
		Find(&keep).Error; err != nil {
		return err
	}
	if keep.ID == 0 {
		return nil
	}
	return DisableOtherAnnouncements(DB, keep.ID)
}

// GetAnnouncement 按 ID 取公告。
func GetAnnouncement(id uint) (*Announcement, error) {
	var item Announcement
	if err := DB.First(&item, id).Error; err != nil {
		return nil, err
	}
	return &item, nil
}

// MigrateAnnouncementScrollModeBackfill 给 ScrollMode 这列补上与 Scroll 一致的取值。
//
// 加列时数据库默认是 continuous（= 滚动），与历史行为一致；只有显式设过 scroll = false
// （不滚动）的老公告需要改成 none，否则升级后它们会突然开始滚动。
// 与 Scroll 那次回填同理，必须在主 AutoMigrate 循环之前调用。
func MigrateAnnouncementScrollModeBackfill() error {
	if DB.Migrator().HasColumn(&Announcement{}, "ScrollMode") {
		return nil
	}
	if err := DB.AutoMigrate(&Announcement{}); err != nil {
		return fmt.Errorf("给 announcements 加 scroll_mode 列失败（应用账号若不是该表 owner，"+
			"请让 DBA 用 owner 账号执行：ALTER TABLE announcements "+
			"ADD COLUMN IF NOT EXISTS scroll_mode varchar(16) NOT NULL DEFAULT 'continuous'）：%w", err)
	}
	return DB.
		Model(&Announcement{}).
		Where("scroll = ?", false).
		Update("scroll_mode", AnnouncementScrollNone).Error
}

// MigrateAnnouncementScrollBackfill 给「升级前就存在的公告」补上 scroll = true。
//
// Scroll 是后加的列，AutoMigrate 给存量行填的是零值 false（= 不滚动），而历史行为一直是
// 横向滚动——不回填的话，升级后所有老公告会突然停住不动。
//
// 只在「列刚被加出来」那一次执行：先问列在不在，再自己建，两次之间就是加列的那一刻。
// 因此**必须在主 AutoMigrate 循环之前调用**（跑完主循环就分不清这列是新加的还是本就有）。
// 全新安装时表还不存在，也按「刚加列」处理：空表上回填是无害的。
func MigrateAnnouncementScrollBackfill() error {
	if DB.Migrator().HasColumn(&Announcement{}, "Scroll") {
		return nil
	}
	if err := DB.AutoMigrate(&Announcement{}); err != nil {
		return fmt.Errorf("给 announcements 加 scroll 列失败（应用账号若不是该表 owner，"+
			"请让 DBA 用 owner 账号执行：ALTER TABLE announcements "+
			"ADD COLUMN IF NOT EXISTS scroll boolean NOT NULL DEFAULT true）：%w", err)
	}
	return DB.Model(&Announcement{}).Where("scroll = ?", false).Update("scroll", true).Error
}
