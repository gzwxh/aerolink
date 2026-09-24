import { useCallback, useState } from 'react'
import { useSettingsSectionAccess } from '@/contexts/settings-section-context'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import type { AnnouncementLevel } from '@/lib/announcement-markup'
import {
  useAllAnnouncements,
  useCreateAnnouncement,
  useDeleteAnnouncement,
  useUpdateAnnouncement,
  type Announcement,
  type AnnouncementPayload,
} from '@/lib/api'
import type { AnnouncementScrollMode } from '@/lib/api'
import { announcementScrollMode } from '@/lib/announcement-scroll'
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
import { DateTimePicker } from '@/components/date-time-picker'
import { UnsavedChangesConfirmDialog } from '@/components/unsaved-changes-confirm-dialog'

/**
 * 通知栏公告管理：发布在页面顶端的滚动公告。
 *
 * 正文是 Markdown 子集 + 具名颜色标记，编辑时旁边给实时预览——
 * 横幅用的是同一个渲染组件，所以预览里什么样、线上就什么样。
 * 见 plans/2026-09-21-announcement-bar.md。
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
  /** 顶栏横向滚动的方式；none 时单行显示，靠拖动或「展开全文」读剩下的内容。 */
  scrollMode: AnnouncementScrollMode
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
  startAt: '',
  endAt: '',
}

function toForm(announcement: Announcement | null): AnnouncementForm {
  if (!announcement) {
    return { ...emptyDraft }
  }
  return {
    title: announcement.title,
    content: announcement.content,
    level: announcement.level,
    priority: announcement.priority,
    enabled: announcement.enabled,
    // 老数据没有 scrollMode 时按 scroll 推导（见 lib/announcement-scroll.ts）。
    scrollMode: announcementScrollMode(announcement),
    startAt: fromRFC3339(announcement.startAt),
    endAt: fromRFC3339(announcement.endAt),
  }
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
      onSuccess: () => toast.success(t('common.messages.deleted', '已删除')),
      onError: (error) => toast.error(translateError(error, t)),
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          {t(
            'notifications.announcements.description',
            '公告显示在所有用户页面顶端的通知栏里，按优先级顺序滚动输出；按生效时间自动出现与消失。'
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
            return (
              <div
                key={item.id}
                className="flex items-start justify-between gap-4 rounded-md border p-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{item.title}</span>
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
                      {announcementScrollMode(item) === 'none'
                        ? t('notifications.announcements.scrollOff', '不滚动')
                        : announcementScrollMode(item) === 'paced'
                          ? t(
                              'notifications.announcements.scrollPaced',
                              '横向滚动（每轮停留）'
                            )
                          : t(
                              'notifications.announcements.scrollOn',
                              '横向滚动'
                            )}
                    </span>
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

  const canSubmit =
    draft.title.trim() !== '' &&
    draft.content.trim() !== '' &&
    !saving &&
    !readOnly

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

          {/* 单列：预览区块已去掉，内容编辑器独占整宽。
              去掉预览是因为它与输入区**必然对不上**——预览走最终渲染，输入区是受控子集的
              所见即所得，并排放只会让人反复怀疑是不是自己写错了（见 §12.13）。 */}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="announcement-title">
                {t('notifications.announcements.fields.title', '标题')}
              </Label>
              <Input
                id="announcement-title"
                value={draft.title}
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
                  {t('notifications.announcements.fields.scrollMode', '滚动方式')}
                </Label>
                <p className="text-muted-foreground text-xs">
                  {t(
                    'notifications.announcements.fields.scrollModeHint',
                    '「连续滚动」一轮接一轮；「每轮停留」走完一圈会停一下再开始，长内容更容易读完；「不滚动」则单行显示，靠拖动或右侧箭头展开读全文。'
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
                    '关闭后不会展示在顶栏，公告内容仍会保留。'
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
