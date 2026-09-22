/**
 * 产品改名（Kite → 鸢联 AeroLink）后的一次性存储键迁移。
 *
 * 新键还没有值、旧键有值时，把旧值原样搬到新键并删掉旧键；两者都有值（或都没有）时
 * 什么都不做。因此重复调用是幂等的，放在读取路径上也不会覆盖用户新写入的偏好。
 */

/** 当前键前缀。 */
export const STORAGE_KEY_PREFIX = 'aerolink-'
/** 旧产品名时期的键前缀。 */
export const LEGACY_STORAGE_KEY_PREFIX = 'kite-'

/**
 * 把某个具体的旧键迁移到新键。`storage` 可以是 localStorage 或 sessionStorage。
 */
export function migrateLegacyStorageKey(
  storage: Storage,
  legacyKey: string,
  newKey: string
): void {
  try {
    if (storage.getItem(newKey) !== null) return
    const legacyValue = storage.getItem(legacyKey)
    if (legacyValue === null) return
    storage.setItem(newKey, legacyValue)
    storage.removeItem(legacyKey)
  } catch {
    // 禁用站点数据、沙箱 iframe、配额满等场景下存储不可访问：跳过迁移，
    // 读取方会回落到默认值，不能因此让调用方抛错。
  }
}

/**
 * 按 `aerolink-` → `kite-` 的前缀对应关系迁移一个键。键名不符合当前前缀时不做任何事，
 * 因此可以安全地用在通用的读取路径上（如 `useTableColumnVisibility`）。
 */
export function migrateLegacyKiteStorageKey(
  storage: Storage,
  key: string
): void {
  if (!key.startsWith(STORAGE_KEY_PREFIX)) return
  migrateLegacyStorageKey(
    storage,
    `${LEGACY_STORAGE_KEY_PREFIX}${key.slice(STORAGE_KEY_PREFIX.length)}`,
    key
  )
}
