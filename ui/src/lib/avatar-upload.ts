/**
 * 头像上传前的统一化：裁剪、缩放、重编码。
 *
 * 处理流程在 `lib/square-image.ts`（集群徽章图标与头像共用），这里只固定头像这一侧的
 * 参数：目标边长、体积上限，以及 `avatar_` 前缀的错误码。
 *
 * 服务端只收 PNG / JPEG 且不超过 1 MiB、边长不超过 1024（见 `pkg/imageupload`，
 * 由 `pkg/users/avatar.go` 使用）。上传前会在浏览器里裁方并缩放到 512×512 以内，
 * 所以正常的用户操作撞不到服务端上限。
 */

import {
  createSquareImageProcessor,
  type SquareCrop,
  type SquareImageFailure,
} from './square-image'

export type { SquareCrop }

/** 与服务端 imageupload.MaxBytes 保持一致（pkg/imageupload/imageupload.go）。 */
export const AVATAR_MAX_BYTES = 1 << 20
/** 与服务端 imageupload.MaxDimension 保持一致。 */
export const AVATAR_MAX_DIMENSION = 1024
/** 上传前的目标边长：头像最大显示 64px，512 足够清晰且体积很小。 */
export const AVATAR_TARGET_SIZE = 512

/**
 * 客户端错误码。刻意用 `avatar_client_` 前缀：`translateError` 按 `avatar_` 前缀
 * 统一映射到 `avatarUpload.errors.<code>`，这样浏览器侧与服务端（`avatar_*`）
 * 的失败原因走同一套文案，不必在组件里各写一份。
 */
export type AvatarUploadErrorCode = `avatar_client_${SquareImageFailure}`

export class AvatarUploadError extends Error {
  readonly code: AvatarUploadErrorCode

  constructor(code: AvatarUploadErrorCode) {
    super(code)
    this.name = 'AvatarUploadError'
    this.code = code
  }
}

const avatarImage = createSquareImageProcessor({
  targetSize: AVATAR_TARGET_SIZE,
  maxBytes: AVATAR_MAX_BYTES,
  fileName: (extension) => `avatar.${extension}`,
  makeError: (failure) => new AvatarUploadError(`avatar_client_${failure}`),
})

/**
 * 计算「居中裁方 + 缩放到目标尺寸」的取景参数（默认目标为 `AVATAR_TARGET_SIZE`）。
 *
 * 单独抽成纯函数便于单测：canvas 在 jsdom 里跑不了，而算错取景会直接导致
 * 头像被拉伸或裁到边角。
 */
export const squareCrop = avatarImage.squareCrop

/**
 * 把用户选中的文件处理成可直接上传的 PNG/JPEG。
 *
 * 非图片、浏览器解不出的格式（例如 Chrome 不支持的 HEIC）抛
 * `AvatarUploadError`，调用方按 `code` 出提示。
 */
export const prepareAvatarFile = avatarImage.prepare
