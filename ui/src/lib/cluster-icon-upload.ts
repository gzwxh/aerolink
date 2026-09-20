/**
 * 集群徽章图标上传前的统一化：裁剪、缩放、重编码。
 *
 * 处理流程在 `lib/square-image.ts`（与头像共用），这里只固定图标这一侧的参数：
 * 目标边长、体积上限，以及 `cluster_icon_` 前缀的错误码。
 *
 * 服务端限制见 `pkg/imageupload`（由 `pkg/cluster/cluster_badge_icon.go` 使用）：
 * PNG / JPEG、不超过 1 MiB、边长不超过 1024。
 */

import {
  createSquareImageProcessor,
  type SquareImageFailure,
} from './square-image'

/** 与服务端 imageupload.MaxBytes 保持一致（pkg/imageupload/imageupload.go）。 */
export const CLUSTER_ICON_MAX_BYTES = 1 << 20
/** 与服务端 imageupload.MaxDimension 保持一致。 */
export const CLUSTER_ICON_MAX_DIMENSION = 1024
/**
 * 上传前的目标边长：图标最大显示 20px（弹窗预览），256 已经远超实际需要，
 * 又能把体积压到几十 KB —— 图标会跟着集群列表一起下发地址，越小越好。
 */
export const CLUSTER_ICON_TARGET_SIZE = 256

/**
 * 客户端错误码。前缀必须是 `cluster_icon_`：`translateError` 按它把浏览器侧
 * （`cluster_icon_client_*`）与服务端（`cluster_icon_*`）的失败原因映射到
 * `clusterBadge.errors.*` 同一套文案，不必在组件里各写一份。
 */
export type ClusterIconUploadErrorCode =
  `cluster_icon_client_${SquareImageFailure}`

export class ClusterIconUploadError extends Error {
  readonly code: ClusterIconUploadErrorCode

  constructor(code: ClusterIconUploadErrorCode) {
    super(code)
    this.name = 'ClusterIconUploadError'
    this.code = code
  }
}

const clusterIconImage = createSquareImageProcessor({
  targetSize: CLUSTER_ICON_TARGET_SIZE,
  maxBytes: CLUSTER_ICON_MAX_BYTES,
  fileName: (extension) => `cluster-icon.${extension}`,
  makeError: (failure) => new ClusterIconUploadError(`cluster_icon_client_${failure}`),
})

/**
 * 把用户选中的文件处理成可直接上传的 PNG/JPEG。
 *
 * 非图片、浏览器解不出的格式抛 `ClusterIconUploadError`，调用方按 `code` 出提示。
 */
export async function prepareClusterIconFile(file: File): Promise<File> {
  return clusterIconImage.prepare(file)
}
