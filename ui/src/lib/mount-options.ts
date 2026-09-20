/**
 * mountOptions 在 StorageClass 与 PersistentVolume 上写法相同，共用这一份解析。
 *
 * 逗号或换行分隔、丢弃空白项；值里本身包含逗号（例如 `-o context="a,b"`）的写法会被
 * 切开，这类场景用创建页的 YAML 编辑器直接写。
 */
export function parseMountOptions(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
}
