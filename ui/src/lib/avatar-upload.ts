/**
 * 头像上传前的统一化：裁剪、缩放、重编码。
 *
 * 服务端只收 PNG / JPEG 且不超过 1 MiB、边长不超过 1024（见 `pkg/users/avatar.go`）。
 * 让用户自己去满足这些条件是不现实的：手机照片动辄 2–5 MB、尺寸 4000px 起，
 * 浏览器截图常常是 WebP。这里在**浏览器里**统一处理，用户几乎可以随便选图：
 *
 *   1. 用 `<input type="file" accept="image/*">` 收下任意浏览器能解码的图片；
 *   2. 居中裁成正方形（头像位置就是方的，拉伸会变形）；
 *   3. 缩放到 `AVATAR_TARGET_SIZE` 以内；
 *   4. 重新编码：有透明通道用 PNG，否则用 JPEG。
 *
 * 动图（GIF/WebP）只会保留当前帧 —— 头像位置本来也不会播动画。
 */

/** 与服务端 maxAvatarBytes 保持一致（pkg/users/avatar.go）。 */
export const AVATAR_MAX_BYTES = 1 << 20
/** 与服务端 maxAvatarDimension 保持一致。 */
export const AVATAR_MAX_DIMENSION = 1024
/** 上传前的目标边长：头像最大显示 64px，512 足够清晰且体积很小。 */
export const AVATAR_TARGET_SIZE = 512
/** JPEG 重编码质量。 */
const AVATAR_JPEG_QUALITY = 0.9

/**
 * 客户端错误码。刻意用 `avatar_client_` 前缀：`translateError` 按 `avatar_` 前缀
 * 统一映射到 `avatarUpload.errors.<code>`，这样浏览器侧与服务端（`avatar_*`）
 * 的失败原因走同一套文案，不必在组件里各写一份。
 */
export type AvatarUploadErrorCode =
  | 'avatar_client_not_image'
  | 'avatar_client_decode_failed'
  | 'avatar_client_encode_failed'
  | 'avatar_client_too_large'

export class AvatarUploadError extends Error {
  readonly code: AvatarUploadErrorCode

  constructor(code: AvatarUploadErrorCode) {
    super(code)
    this.name = 'AvatarUploadError'
    this.code = code
  }
}

export interface SquareCrop {
  /** 源图上的裁剪起点（居中裁方）。 */
  sx: number
  sy: number
  /** 裁剪边长（源图坐标）。 */
  size: number
  /** 缩放后的输出边长。 */
  output: number
}

/**
 * 计算「居中裁方 + 缩放到目标尺寸」的取景参数。
 *
 * 单独抽成纯函数便于单测：canvas 在 jsdom 里跑不了，而算错取景会直接导致
 * 头像被拉伸或裁到边角。
 */
export function squareCrop(
  width: number,
  height: number,
  target: number = AVATAR_TARGET_SIZE
): SquareCrop {
  if (!(width > 0) || !(height > 0)) {
    throw new AvatarUploadError('avatar_client_decode_failed')
  }
  const size = Math.min(width, height)
  return {
    sx: Math.floor((width - size) / 2),
    sy: Math.floor((height - size) / 2),
    size,
    // 不放大：小图保持原尺寸，避免糊成一片。
    output: Math.min(size, target),
  }
}

type DrawableImage = {
  width: number
  height: number
  draw: (ctx: CanvasRenderingContext2D, crop: SquareCrop) => void
  close: () => void
}

async function loadDrawableImage(file: File): Promise<DrawableImage> {
  // createImageBitmap 能直接解码，且不会被浏览器按 EXIF 方向忽略：
  // 手机上竖拍的照片在这里已经是「正」的，省掉自己解析 EXIF。
  if (typeof createImageBitmap === 'function') {
    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(file)
    } catch {
      throw new AvatarUploadError('avatar_client_decode_failed')
    }
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: (ctx, crop) => {
        ctx.drawImage(
          bitmap,
          crop.sx,
          crop.sy,
          crop.size,
          crop.size,
          0,
          0,
          crop.output,
          crop.output
        )
      },
      close: () => bitmap.close(),
    }
  }

  // 兜底：老浏览器走 <img> + blob URL。
  const objectUrl = URL.createObjectURL(file)
  const image = new Image()
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () =>
        reject(new AvatarUploadError('avatar_client_decode_failed'))
      image.src = objectUrl
    })
  } catch (error) {
    URL.revokeObjectURL(objectUrl)
    throw error instanceof AvatarUploadError
      ? error
      : new AvatarUploadError('avatar_client_decode_failed')
  }
  return {
    width: image.naturalWidth,
    height: image.naturalHeight,
    draw: (ctx, crop) => {
      ctx.drawImage(
        image,
        crop.sx,
        crop.sy,
        crop.size,
        crop.size,
        0,
        0,
        crop.output,
        crop.output
      )
    },
    close: () => URL.revokeObjectURL(objectUrl),
  }
}

/** 画到 canvas 上并按需重编码；优先 PNG（保留透明），超过上限再退回 JPEG。 */
async function encodeSquare(
  source: DrawableImage,
  crop: SquareCrop
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = crop.output
  canvas.height = crop.output
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new AvatarUploadError('avatar_client_encode_failed')
  }
  // 透明区域填白：JPEG 没有 alpha 通道，直接编码透明像素会变成黑底。
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, crop.output, crop.output)
  source.draw(ctx, crop)

  const toBlob = (type: string, quality?: number) =>
    new Promise<Blob | null>((resolve) =>
      canvas.toBlob((blob) => resolve(blob), type, quality)
    )

  const png = await toBlob('image/png')
  if (png && png.size <= AVATAR_MAX_BYTES) {
    return png
  }
  const jpeg = await toBlob('image/jpeg', AVATAR_JPEG_QUALITY)
  if (jpeg && jpeg.size <= AVATAR_MAX_BYTES) {
    return jpeg
  }
  throw new AvatarUploadError('avatar_client_too_large')
}

/**
 * 把用户选中的文件处理成可直接上传的 PNG/JPEG。
 *
 * 非图片、浏览器解不出的格式（例如 Chrome 不支持的 HEIC）抛
 * `AvatarUploadError`，调用方按 `code` 出提示。
 */
export async function prepareAvatarFile(file: File): Promise<File> {
  if (!file.type.startsWith('image/')) {
    throw new AvatarUploadError('avatar_client_not_image')
  }

  const source = await loadDrawableImage(file)
  try {
    const crop = squareCrop(source.width, source.height)
    const blob = await encodeSquare(source, crop)
    const extension = blob.type === 'image/png' ? 'png' : 'jpg'
    // 服务端只按内容判定，文件名仅用于日志/错误说明。
    return new File([blob], `avatar.${extension}`, { type: blob.type })
  } finally {
    source.close()
  }
}
