import { useCallback, useState } from 'react'
import { useSettingsSectionAccess } from '@/contexts/settings-section-context'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import type { AnnouncementLevel } from '@/lib/announcement-markup'
import {
  ANNOUNCEMENT_DEFAULT_PAUSE_SECONDS,
  ANNOUNCEMENT_DEFAULT_SCROLL_SPEED,
  ANNOUNCEMENT_DISPLAY_SECONDS_MAX,
  ANNOUNCEMENT_DISPLAY_SECONDS_MIN,
  ANNOUNCEMENT_PAUSE_SECONDS_MAX,
  ANNOUNCEMENT_SCROLL_SPEED_MAX,
  ANNOUNCEMENT_SCROLL_SPEED_MIN,
  announcementScrollMode,
  announcementScrollParams,
} from '@/lib/announcement-scroll'
import {
  useAllAnnouncements,
  useCreateAnnouncement,
  useDeleteAnnouncement,
  useUpdateAnnouncement,
  type Announcement,
  type AnnouncementPayload,
} from '@/lib/api'
import type { AnnouncementScrollMode } from '@/lib/api'
import { formatDateTimeShort, fromRFC3339, toRFC3339 } from '@/lib/date-time'
import {
  neutralBadge,
  statusBadge,
  type StatusBadgeStyle,
} from '@/lib/status-badge'
import { translateError } from '@/lib/utils'
import {
  useDraftDirty,
  useUnsavedChangesGuard,
} from '@/hooks/use-unsaved-changes-guard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { AnnouncementContent } from '@/components/announcement-content'
import { AnnouncementEditor } from '@/components/announcement-editor'
import { AnnouncementTicker } from '@/components/announcement-ticker'
import { DateTimePicker } from '@/components/date-time-picker'
import { UnsavedChangesConfirmDialog } from '@/components/unsaved-changes-confirm-dialog'

/**
 * 通知栏公告管理：发布在页面顶端的滚动公告。
 *
 * 正文是 Markdown 子集 + 具名颜色标记，编辑时旁边给实时预览——
 * 横幅用的是同一个渲染组件，所以预览里什么样、线上就什么样。
 * 见 plans/2026-09-21-顶部通知栏.md。
 */

const LEVELS: AnnouncementLevel[] = ['info', 'warning', 'danger']

/** 表单下拉里的滚动方式（顺序即展示顺序：默认的连续滚动排第一）。 */
const ANNOUNCEMENT_SCROLL_MODES: AnnouncementScrollMode[] = [
  'continuous',
  'paced',
  'none',
]

const SCROLL_MODE_LABELS: Record<AnnouncementScrollMode, string> = {
  continuous: 'notifications.announcements.scrollModes.continuous',
  paced: 'notifications.announcements.scrollModes.paced',
  none: 'notifications.announcements.scrollModes.none',
}

type AnnouncementStatus = 'active' | 'pending' | 'expired' | 'disabled'

/** 与后端 model.ListActiveAnnouncements 的过滤条件同口径。 */
function statusOf(item: Announcement, now = Date.now()): AnnouncementStatus {
  if (!item.enabled) {
    return 'disabled'
  }
  if (item.startAt && new Date(item.startAt).getTime() > now) {
    return 'pending'
  }
  if (item.endAt && new Date(item.endAt).getTime() <= now) {
    return 'expired'
  }
  return 'active'
}

// 公告状态同样是状态色：生效=成功、待生效=进行中（info）、过期的停用的用中性。
const STATUS_BADGES: Record<AnnouncementStatus, StatusBadgeStyle> = {
  active: statusBadge('success'),
  pending: statusBadge('info'),
  expired: neutralBadge(),
  disabled: neutralBadge(),
}

function formatWindow(item: Announcement, never: string): string {
  const start = formatDateTimeShort(fromRFC3339(item.startAt)) || never
  const end = formatDateTimeShort(fromRFC3339(item.endAt)) || never
  return `${start} → ${end}`
}

/** 表单草稿：时间用本地字符串编辑（与日期选择器同一口径），提交时才转 RFC3339。 */
interface AnnouncementForm {
  title: string
  content: string
  level: AnnouncementLevel
  priority: number
  enabled: boolean
  /** 顶栏横向滚动的方式；none 时单行显示，靠左右拖动看剩下的内容。 */
  scrollMode: AnnouncementScrollMode
  // 三个数值参数在草稿里存字符串：数字受控输入在删空的那一刻会被迫回落成默认值，
  // 管理员就没法「清空再输一个」了（只能一点点加减）。空串 = 用默认值，提交时解析。
  /** 滚动速度（像素/秒），越大越快；空串 = 默认 60。 */
  scrollSpeed: string
  /** 「每轮停留」的秒数，只在「每轮停留」方式下生效；空串 = 默认 2。 */
  pauseSeconds: string
  /** 一轮滚完的秒数；空串或 0 表示不填，按速度自动计算。 */
  displaySeconds: string
  startAt: string
  endAt: string
}

const emptyDraft: AnnouncementForm = {
  title: '',
  content: '',
  level: 'info',
  priority: 0,
  enabled: true,
  // 默认连续滚动，与历史行为一致（后端缺省值也是 continuous）。
  scrollMode: 'continuous',
  // 三个滚动参数的默认值就是升级前写死的常量，所以「新建 = 老观感」。
  scrollSpeed: String(ANNOUNCEMENT_DEFAULT_SCROLL_SPEED),
  pauseSeconds: String(ANNOUNCEMENT_DEFAULT_PAUSE_SECONDS),
  // 空 = 不填，按速度自动算。
  displaySeconds: '',
  startAt: '',
  endAt: '',
}

function toForm(announcement: Announcement | null): AnnouncementForm {
  if (!announcement) {
    return { ...emptyDraft }
  }
  // 老数据没有这几个字段，统一走「兜底到默认值」的解析，避免把 undefined 塞进 Input。
  const params = announcementScrollParams(announcement)
  return {
    title: announcement.title,
    content: announcement.content,
    level: announcement.level,
    priority: announcement.priority,
    enabled: announcement.enabled,
    // 老数据没有 scrollMode 时按 scroll 推导（见 lib/announcement-scroll.ts）。
    scrollMode: announcementScrollMode(announcement),
    scrollSpeed: String(params.speed),
    pauseSeconds: String(params.pauseSeconds),
    // 0（自动）在草稿里就是空串，输入框显示占位符「自动」而不是一个 0 秒。
    displaySeconds:
      params.displaySeconds > 0 ? String(params.displaySeconds) : '',
    startAt: fromRFC3339(announcement.startAt),
    endAt: fromRFC3339(announcement.endAt),
  }
}

/**
 * 草稿里的数字字符串 → 数字：空串与非数字都回落到默认值。
 *
 * 允许空串是为了「清空再重输」，所以空值必须有确定含义——这里就是默认值，
 * 与不填时的行为一致，不会因为手滑删空而把速度变成 0。
 */
function draftNumber(value: string, fallback: number): number {
  const parsed = Number(value)
  return value.trim() !== '' && Number.isFinite(parsed) ? parsed : fallback
}

function toPayload(form: AnnouncementForm): AnnouncementPayload {
  return {
    title: form.title,
    content: form.content,
    level: form.level,
    priority: form.priority,
    enabled: form.enabled,
    // 两个字段一起发且保持一致：scrollMode 是新口径，scroll 给老客户端/老后端读。
    scroll: form.scrollMode !== 'none',
    scrollMode: form.scrollMode,
    scrollSpeed: draftNumber(
      form.scrollSpeed,
      ANNOUNCEMENT_DEFAULT_SCROLL_SPEED
    ),
    pauseSeconds: draftNumber(
      form.pauseSeconds,
      ANNOUNCEMENT_DEFAULT_PAUSE_SECONDS
    ),
    displaySeconds: draftNumber(form.displaySeconds, 0),
    // 空串由后端当作「立即生效 / 永不过期」。
    startAt: toRFC3339(form.startAt) ?? '',
    endAt: toRFC3339(form.endAt) ?? '',
  }
}

/**
 * 列表行内的接口是覆盖式的 PUT，因此要把整条公告回传。
 * 服务端给的时间本来就是 RFC3339，原样带回即可（只把可空字段归一成空串）。
 */
function announcementToPayload(item: Announcement): AnnouncementPayload {
  const params = announcementScrollParams(item)
  return {
    title: item.title,
    content: item.content,
    level: item.level,
    priority: item.priority,
    enabled: item.enabled,
    // 行内改级别/启用时会把整条公告回传（接口是覆盖式 PUT），这里必须带上滚动方式，
    // 否则一次行内改动就会把设置重置掉。老数据缺字段时按 scroll 推导。
    scroll: item.scroll !== false,
    scrollMode: announcementScrollMode(item),
    // 同理，三个滚动参数也要带上，否则行内改一下启用就把速度/停留/时长重置成默认值。
    scrollSpeed: params.speed,
    pauseSeconds: params.pauseSeconds,
    displaySeconds: params.displaySeconds,
    startAt: item.startAt ?? '',
    endAt: item.endAt ?? '',
  }
}

export function AnnouncementManagement() {
  const { t } = useTranslation()
  const { readOnly } = useSettingsSectionAccess()
  const { data, isLoading } = useAllAnnouncements()
  const createAnnouncement = useCreateAnnouncement()
  const updateAnnouncement = useUpdateAnnouncement()
  const deleteAnnouncement = useDeleteAnnouncement()
  const [editing, setEditing] = useState<Announcement | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null)
  // 正在行内改哪一条（启用/级别）：只锁那一行的控件，不做全局忙碌态。
  const [updatingId, setUpdatingId] = useState<number | null>(null)

  const items = data?.items ?? []

  /** 行内改一个字段：其余字段原样回传（接口是整体覆盖式的 PUT）。 */
  const patchItem = (
    item: Announcement,
    patch: Partial<Pick<Announcement, 'enabled' | 'level'>>
  ) => {
    setUpdatingId(item.id)
    updateAnnouncement.mutate(
      { id: item.id, data: announcementToPayload({ ...item, ...patch }) },
      {
        onSuccess: () =>
          toast.success(t('notifications.messages.saved', '已保存')),
        onError: (error) => toast.error(translateError(error, t)),
        onSettled: () => setUpdatingId(null),
      }
    )
  }

  const openCreate = () => {
    setEditing(null)
    setDialogOpen(true)
  }
  const openEdit = (item: Announcement) => {
    setEditing(item)
    setDialogOpen(true)
  }

  const handleDelete = (id: number) => {
    // 两段式确认：第一次点击进入确认态（按钮自身变成「确认删除？」），再次点击才真删。
    if (confirmingDelete !== id) {
      setConfirmingDelete(id)
      return
    }
    setConfirmingDelete(null)
    deleteAnnouncement.mutate(id, {
      // `common.messages.deleted` 的模板是 `{{resource}}删除成功`：不传 resource 就会把
      // 占位符原样贴到界面上（第 16 轮实测）。与 API 密钥等管理页同一口径传资源名。
      onSuccess: () =>
        toast.success(
          t('common.messages.deleted', {
            resource: t('notifications.announcements.item', '公告'),
          })
        ),
      onError: (error) => toast.error(translateError(error, t)),
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {t(
            'notifications.announcements.description',
            '公告显示在所有用户页面顶端的通知栏里；同一时间只展示一条（启用的那条），按生效时间自动出现与消失。'
          )}
        </p>
        <Button size="sm" disabled={readOnly} onClick={openCreate}>
          {t('common.actions.add', '新增')}
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">
          {t('common.messages.loading', '加载中...')}
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('notifications.announcements.empty', '暂无公告')}
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const status = statusOf(item)
            const ownMode = announcementScrollMode(item)
            const ownParams = announcementScrollParams(item)
            return (
              <div
                key={item.id}
                className="flex items-start justify-between gap-4 rounded-md border p-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {/* 标题可选：没填时给个占位，否则行首是一片空白，扫列表分不清哪条是哪条。 */}
                    {item.title.trim() === '' ? (
                      <span className="truncate font-medium text-muted-foreground">
                        {t('notifications.announcements.untitled', '无标题')}
                      </span>
                    ) : (
                      <span className="truncate font-medium">{item.title}</span>
                    )}
                    <Badge {...STATUS_BADGES[status]}>
                      {t(`notifications.announcements.status.${status}`)}
                    </Badge>
                  </div>
                  <div className="truncate text-sm text-muted-foreground">
                    <AnnouncementContent content={item.content} />
                  </div>
                  {/* 把这条的配置逐项写出来：右侧只有下拉与开关，扫一眼列表读不出
                      「现在是启用还是停用」「滚不滚动」，得逐条点开编辑才知道。 */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    <span className="tabular-nums">
                      {formatWindow(
                        item,
                        t('notifications.announcements.never', '不限')
                      )}
                    </span>
                    <span>
                      {t('notifications.announcements.fields.level', '级别')}：
                      {t(`notifications.announcements.levels.${item.level}`)}
                    </span>
                    <span className="tabular-nums">
                      {t(
                        'notifications.announcements.fields.priority',
                        '优先级'
                      )}
                      ：{item.priority}
                    </span>
                    <span>
                      {item.enabled
                        ? t('notifications.announcements.enabledOn', '已启用')
                        : t('notifications.announcements.enabledOff', '已停用')}
                    </span>
                    <span>
                      {ownMode === 'none'
                        ? t('notifications.announcements.scrollOff', '不滚动')
                        : ownMode === 'paced'
                          ? t(
                              'notifications.announcements.scrollPaced',
                              '横向滚动（每轮停留）'
                            )
                          : t(
                              'notifications.announcements.scrollOn',
                              '横向滚动'
                            )}
                    </span>
                    {/* 速度/显示时长是这次新放出来的参数，列表里跟着标出来：
                        不点开编辑也能看出这条滚多快、一轮多久。 */}
                    {ownMode === 'none' ? null : (
                      <>
                        <span className="tabular-nums">
                          {/* 填了「显示时长」就不按速度换算，此时再写「速度 300 px/s」
                              只会让人以为速度该生效——那正好是「设置了不生效」的来源。 */}
                          {ownParams.displaySeconds > 0
                            ? t(
                                'notifications.announcements.fields.displayShort',
                                {
                                  value: ownParams.displaySeconds,
                                  defaultValue: '一轮 {{value}} s',
                                }
                              )
                            : t(
                                'notifications.announcements.fields.scrollSpeedShort',
                                {
                                  value: ownParams.speed,
                                  defaultValue: '速度 {{value}} px/s',
                                }
                              )}
                          {' · '}
                          {ownParams.displaySeconds > 0
                            ? t(
                                'notifications.announcements.fields.pauseShort',
                                {
                                  value: ownParams.pauseSeconds,
                                  defaultValue: '停留 {{value}} s',
                                }
                              )
                            : t(
                                'notifications.announcements.fields.displayAuto',
                                '一轮自动'
                              )}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {/* 启用与级别直接在这一行改，不必先点「编辑」：这两个是最常调的开关。 */}
                  <Select
                    value={item.level}
                    onValueChange={(next) =>
                      patchItem(item, { level: next as AnnouncementLevel })
                    }
                    disabled={readOnly || updatingId === item.id}
                  >
                    <SelectTrigger
                      size="sm"
                      className="w-24"
                      aria-label={t(
                        'notifications.announcements.fields.level',
                        '级别'
                      )}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LEVELS.map((level) => (
                        <SelectItem key={level} value={level}>
                          {t(`notifications.announcements.levels.${level}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Switch
                    checked={item.enabled}
                    onCheckedChange={(next) =>
                      patchItem(item, { enabled: next })
                    }
                    disabled={readOnly || updatingId === item.id}
                    aria-label={t(
                      'notifications.announcements.fields.enabled',
                      '启用'
                    )}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={readOnly}
                    onClick={() => openEdit(item)}
                  >
                    {t('common.actions.edit', '编辑')}
                  </Button>
                  <Button
                    size="sm"
                    variant={
                      confirmingDelete === item.id ? 'destructive' : 'outline'
                    }
                    disabled={deleteAnnouncement.isPending}
                    onMouseLeave={() =>
                      setConfirmingDelete((current) =>
                        current === item.id ? null : current
                      )
                    }
                    onClick={() => handleDelete(item.id)}
                  >
                    {confirmingDelete === item.id
                      ? t('common.actions.confirm', '确认')
                      : t('common.actions.delete', '删除')}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {dialogOpen ? (
        <AnnouncementDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          announcement={editing}
          readOnly={readOnly}
          saving={createAnnouncement.isPending || updateAnnouncement.isPending}
          onSubmit={(payload) => {
            const onSuccess = () => {
              toast.success(t('notifications.messages.saved', '已保存'))
              setDialogOpen(false)
            }
            const onError = (error: unknown) =>
              toast.error(translateError(error, t))
            if (editing) {
              updateAnnouncement.mutate(
                { id: editing.id, data: payload },
                { onSuccess, onError }
              )
              return
            }
            createAnnouncement.mutate(payload, { onSuccess, onError })
          }}
        />
      ) : null}
    </div>
  )
}

function AnnouncementDialog({
  open,
  onOpenChange,
  announcement,
  readOnly,
  saving,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  announcement: Announcement | null
  readOnly: boolean
  saving: boolean
  onSubmit: (payload: AnnouncementPayload) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<AnnouncementForm>(() =>
    toForm(announcement)
  )
  // 每次打开都是新挂载的实例，所以「有没有改动」的基线就是初始草稿。
  const isDirty = useDraftDirty(draft)
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const guard = useUnsavedChangesGuard({
    dirty: isDirty && !saving,
    onClose: close,
  })

  const patch = <K extends keyof AnnouncementForm>(
    key: K,
    next: AnnouncementForm[K]
  ) => setDraft((current) => ({ ...current, [key]: next }))

  const canSubmit = draft.content.trim() !== '' && !saving && !readOnly

  // 草稿解析成公告的滚动字段：预览要用，所以和表单分开算。
  const draftSource = {
    scroll: draft.scrollMode !== 'none',
    scrollMode: draft.scrollMode,
    scrollSpeed: draftNumber(
      draft.scrollSpeed,
      ANNOUNCEMENT_DEFAULT_SCROLL_SPEED
    ),
    pauseSeconds: draftNumber(
      draft.pauseSeconds,
      ANNOUNCEMENT_DEFAULT_PAUSE_SECONDS
    ),
    displaySeconds: draftNumber(draft.displaySeconds, 0),
  }

  // 填了「显示时长」就不再按速度换算，速度字段置灰，免得「改了速度没反应」。
  const speedDisabled =
    readOnly ||
    draft.scrollMode === 'none' ||
    draftNumber(draft.displaySeconds, 0) > 0
  const pauseDisabled = readOnly || draft.scrollMode !== 'paced'
  const durationDisabled = readOnly || draft.scrollMode === 'none'

  // 预览：拿当前草稿拼一条「公告」，交给顶栏同一个组件渲染。参数改了立刻能看到
  // 滚多快、停多久，不用先保存再回顶栏猜。
  const previewItem: Announcement = {
    id: announcement?.id ?? 0,
    title: draft.title,
    content: draft.content,
    level: draft.level,
    priority: draft.priority,
    enabled: draft.enabled,
    // scroll / scrollMode / 三个数值参数都在 draftSource 里（已按草稿解析过）。
    ...draftSource,
    startAt: announcement?.startAt ?? '',
    endAt: announcement?.endAt ?? '',
    creatorId: announcement?.creatorId ?? 0,
    createdAt: announcement?.createdAt ?? '',
    updatedAt: announcement?.updatedAt ?? '',
  }
  const previewEmpty = draft.title.trim() === '' && draft.content.trim() === ''

  return (
    <>
      <Dialog open={open} onOpenChange={guard.handleOpenChange}>
        <DialogContent className="sm:!max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {announcement
                ? t('notifications.announcements.editTitle', '编辑公告')
                : t('notifications.announcements.createTitle', '新增公告')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'notifications.announcements.dialogHint',
                '通知栏按一行滚动输出：正文里的换行会被合并，标题会加粗显示在正文前面。'
              )}
            </DialogDescription>
          </DialogHeader>

          {/* 单列：内容编辑器独占整宽。
              预览只放在滚动参数下面一处，且只展示**单行滚动效果**（不并排对比 Markdown），
              避免重蹈「预览与输入区对不上」的覆辙（见 §12.13）。 */}
          {/* min-w-0：DialogContent 是 grid，默认的 min-width:auto 会让「预览里的滚动轨道」
              把整列撑宽（轨道宽度又取决于可视区宽度，于是越撑越宽）。 */}
          <div className="min-w-0 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="announcement-title">
                {t('notifications.announcements.fields.title', '标题')}
                <span className="text-muted-foreground font-normal">
                  {t('notifications.announcements.fields.optional', '（可选）')}
                </span>
              </Label>
              <Input
                id="announcement-title"
                value={draft.title}
                placeholder={t(
                  'notifications.announcements.fields.titlePlaceholder',
                  '不填则横幅只显示内容'
                )}
                onChange={(event) => patch('title', event.target.value)}
                disabled={readOnly}
              />
            </div>

            <div className="space-y-2">
              <Label id="announcement-content-label">
                {t('notifications.announcements.fields.content', '内容')}
              </Label>
              <AnnouncementEditor
                id="announcement-content"
                value={draft.content}
                onChange={(next) => patch('content', next)}
                disabled={readOnly}
                labelledBy="announcement-content-label"
              />
              {/* 只有「标题可选」之后才可能出现这种草稿：保存按钮是灰的，不说原因就成了
                  「按钮点不动」。同时说明空公告也不能启用。 */}
              {draft.content.trim() === '' ? (
                <p className="text-warning text-xs">
                  {t(
                    'notifications.announcements.contentRequired',
                    '内容不能为空：标题和正文都空的公告无法保存，也无法启用。'
                  )}
                </p>
              ) : null}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>
                  {t('notifications.announcements.fields.level', '级别')}
                </Label>
                <Select
                  value={draft.level}
                  onValueChange={(value) =>
                    patch('level', value as AnnouncementLevel)
                  }
                  disabled={readOnly}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {t(`notifications.announcements.levels.${level}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="announcement-priority">
                  {t('notifications.announcements.fields.priority', '优先级')}
                </Label>
                <Input
                  id="announcement-priority"
                  type="number"
                  min={0}
                  value={String(draft.priority)}
                  onChange={(event) =>
                    patch('priority', Number(event.target.value) || 0)
                  }
                  disabled={readOnly}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="announcement-start">
                  {t('notifications.announcements.fields.startAt', '生效时间')}
                </Label>
                <DateTimePicker
                  id="announcement-start"
                  value={draft.startAt}
                  onChange={(next) => patch('startAt', next)}
                  disabled={readOnly}
                />
                <p className="text-xs text-muted-foreground">
                  {t(
                    'notifications.announcements.fields.startAtHint',
                    '留空立即生效'
                  )}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="announcement-end">
                  {t('notifications.announcements.fields.endAt', '结束时间')}
                </Label>
                <DateTimePicker
                  id="announcement-end"
                  value={draft.endAt}
                  onChange={(next) => patch('endAt', next)}
                  disabled={readOnly}
                />
                <p className="text-xs text-muted-foreground">
                  {t(
                    'notifications.announcements.fields.endAtHint',
                    '留空永不结束'
                  )}
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <Label htmlFor="announcement-scroll-mode">
                  {t(
                    'notifications.announcements.fields.scrollMode',
                    '滚动方式'
                  )}
                </Label>
                <p className="text-muted-foreground text-xs">
                  {t(
                    'notifications.announcements.fields.scrollModeHint',
                    '「连续滚动」一轮接一轮；「每轮停留」走完一圈会停一下再开始，长内容更容易读完；「不滚动」则单行显示，靠左右拖动看前后文。'
                  )}
                </p>
              </div>
              <Select
                value={draft.scrollMode}
                onValueChange={(value) =>
                  patch('scrollMode', value as AnnouncementScrollMode)
                }
                disabled={readOnly}
              >
                <SelectTrigger
                  id="announcement-scroll-mode"
                  className="w-[180px] shrink-0"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ANNOUNCEMENT_SCROLL_MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {t(SCROLL_MODE_LABELS[mode])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* 三个数值参数：顶栏只展示启用的这一条，所以填什么就按什么走。 */}
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="announcement-scroll-speed">
                  {t(
                    'notifications.announcements.fields.scrollSpeed',
                    '滚动速度'
                  )}
                </Label>
                <Input
                  id="announcement-scroll-speed"
                  type="number"
                  min={ANNOUNCEMENT_SCROLL_SPEED_MIN}
                  max={ANNOUNCEMENT_SCROLL_SPEED_MAX}
                  step={5}
                  // 原样存字符串：删空时不清洗成默认值，管理员可以清空后直接输新数，
                  // 不必从 60 一点点点加减。空串在提交时按默认值算（见 draftNumber）。
                  value={draft.scrollSpeed}
                  placeholder={String(ANNOUNCEMENT_DEFAULT_SCROLL_SPEED)}
                  onChange={(event) => patch('scrollSpeed', event.target.value)}
                  disabled={speedDisabled}
                />
                <p className="text-muted-foreground text-xs">
                  {t('notifications.announcements.fields.scrollSpeedHint', {
                    min: ANNOUNCEMENT_SCROLL_SPEED_MIN,
                    max: ANNOUNCEMENT_SCROLL_SPEED_MAX,
                    defaultValue:
                      '像素/秒（{{min}}~{{max}}），越大越快。填了「显示时长」后速度不再参与计算。',
                  })}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="announcement-pause-seconds">
                  {t(
                    'notifications.announcements.fields.pauseSeconds',
                    '每轮停留'
                  )}
                </Label>
                <Input
                  id="announcement-pause-seconds"
                  type="number"
                  min={1}
                  max={ANNOUNCEMENT_PAUSE_SECONDS_MAX}
                  value={draft.pauseSeconds}
                  placeholder={String(ANNOUNCEMENT_DEFAULT_PAUSE_SECONDS)}
                  onChange={(event) =>
                    patch('pauseSeconds', event.target.value)
                  }
                  disabled={pauseDisabled}
                />
                <p className="text-muted-foreground text-xs">
                  {t('notifications.announcements.fields.pauseSecondsHint', {
                    max: ANNOUNCEMENT_PAUSE_SECONDS_MAX,
                    defaultValue:
                      '走完一圈停多久（秒，1~{{max}}），只在「每轮停留」方式下生效。',
                  })}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="announcement-display-seconds">
                  {t(
                    'notifications.announcements.fields.displaySeconds',
                    '显示时长'
                  )}
                </Label>
                <Input
                  id="announcement-display-seconds"
                  type="number"
                  min={ANNOUNCEMENT_DISPLAY_SECONDS_MIN}
                  max={ANNOUNCEMENT_DISPLAY_SECONDS_MAX}
                  placeholder={t(
                    'notifications.announcements.fields.displaySecondsAuto',
                    '自动'
                  )}
                  // 空 = 不填（自动），显示占位符，而不是让人看到一个 0 秒。
                  value={draft.displaySeconds}
                  onChange={(event) =>
                    patch('displaySeconds', event.target.value)
                  }
                  disabled={durationDisabled}
                />
                <p className="text-muted-foreground text-xs">
                  {t('notifications.announcements.fields.displaySecondsHint', {
                    min: ANNOUNCEMENT_DISPLAY_SECONDS_MIN,
                    max: ANNOUNCEMENT_DISPLAY_SECONDS_MAX,
                    defaultValue:
                      '一轮滚完用多少秒（{{min}}~{{max}}），留空按内容宽度和速度自动算（不短于 15 秒）。',
                  })}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-4">
                <Label>
                  {t('notifications.announcements.preview.label', '预览')}
                </Label>
                <span className="text-muted-foreground text-xs">
                  {t(
                    'notifications.announcements.preview.hint',
                    '按本条配置实时滚动，鼠标悬停暂停'
                  )}
                </span>
              </div>
              {/* w-full 不能省：滚动轨道要根据可视区宽度决定重复几份，而一个宽度由内容
                  决定的 flex 容器会「容器被内容撑宽 → 多重复几份 → 更宽」地正反馈下去
                  （实测预览里 viewport 被撑到 40 万像素、轨道渲染了 7000 多份）。 */}
              <div
                className="flex min-h-9 w-full items-center gap-1 overflow-hidden rounded-md border bg-muted/40 px-3 py-1.5 text-sm"
                data-announcement-preview
              >
                {previewEmpty ? (
                  <span className="text-muted-foreground text-xs">
                    {t(
                      'notifications.announcements.preview.empty',
                      '写上标题或内容后，这里会按顶栏的样式滚动'
                    )}
                  </span>
                ) : (
                  <AnnouncementTicker
                    items={[previewItem]}
                    level={draft.level}
                  />
                )}
              </div>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <Label htmlFor="announcement-enabled">
                  {t('notifications.announcements.fields.enabled', '启用')}
                </Label>
                {/* 光一个开关看不出关掉之后会发生什么：这里把后果写清楚，
                      避免"保存了却没显示"或"以为删掉了其实只是隐藏"这类误解。 */}
                <p className="text-muted-foreground text-xs">
                  {t(
                    'notifications.announcements.fields.enabledHint',
                    '关闭后不会展示在顶栏，公告内容仍会保留；启用这条会自动停用其他公告（同一时间只能启用一条）。'
                  )}
                </p>
              </div>
              <Switch
                id="announcement-enabled"
                checked={draft.enabled}
                onCheckedChange={(value) => patch('enabled', value)}
                disabled={readOnly}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => guard.handleOpenChange(false)}
              disabled={saving}
            >
              {t('common.actions.cancel', '取消')}
            </Button>
            <Button
              type="button"
              disabled={!canSubmit}
              onClick={() => onSubmit(toPayload(draft))}
            >
              {saving
                ? t('notifications.actions.saving', '保存中...')
                : t('common.actions.save', '保存')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <UnsavedChangesConfirmDialog {...guard.confirmDialogProps} />
    </>
  )
}
