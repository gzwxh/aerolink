/**
 * 图片上传前的统一化：裁剪、缩放、重编码。
 *
 * 服务端只收 PNG / JPEG，且有体积与边长上限（见 `pkg/imageupload`）。让用户自己
 * 满足这些条件是不现实的：手机照片动辄 2–5 MB、尺寸 4000px 起，浏览器截图常常是
 * WebP。这些都在**浏览器里**处理掉，用户几乎可以随便选图：
 *
 *   1. 用 `<input type="file" accept="image/*">` 收下任意浏览器能解码的图片；
 *   2. 居中裁成正方形（头像位与图标位都是方的，拉伸会变形）；
 *   3. 缩放到目标边长以内（不放大，避免糊掉）；
 *   4. 重新编码：有透明通道用 PNG，否则用 JPEG。
 *
 * 动图（GIF/WebP）只保留当前帧 —— 这两个位置本来也不播动画。
 *
 * 头像（`lib/avatar-upload.ts`）与集群徽章图标（`lib/cluster-icon-upload.ts`）共用它：
 * 流程一致，只有目标尺寸与错误码前缀不同。错误码由调用方注入，是因为
 * `translateError` 按前缀（`avatar_` / `cluster_icon_`）把失败原因映射到各自的文案，
 * 共用一套文案会让用户看到「头像」字样的集群图标报错。
 */

export interface SquareCrop {
  /** 源图上的裁剪起点（居中裁方）。 */
  sx: number
  sy: number
  /** 裁剪边长（源图坐标）。 */
  size: number
  /** 缩放后的输出边长。 */
  output: number
}

export type SquareImageFailure =
  'not_image' | 'decode_failed' | 'encode_failed' | 'too_large'

export interface SquareImageOptions {
  /** 输出边长上限；比它还小的图不放大。 */
  targetSize: number
  /** 重编码后的字节上限，两者都超就报 `too_large`。 */
  maxBytes: number
  /** 重编码后的文件名。服务端只按内容判定，名字仅用于日志与错误说明。 */
  fileName: (extension: 'png' | 'jpg') => string
  /** 构造带功能前缀的错误码，见文件头的说明。 */
  makeError: (failure: SquareImageFailure) => Error
}

export interface SquareImageProcessor {
  squareCrop: (width: number, height: number, target?: number) => SquareCrop
  prepare: (file: File) => Promise<File>
}

/** JPEG 重编码质量。 */
const JPEG_QUALITY = 0.9

type DrawableImage = {
  width: number
  height: number
  draw: (ctx: CanvasRenderingContext2D, crop: SquareCrop) => void
  close: () => void
}

/**
 * 按给定限制创建一套「裁方 + 缩放 + 重编码」的工具。
 *
 * `squareCrop` 单独暴露成纯函数便于单测：canvas 在 jsdom 里跑不了，
 * 而算错取景会直接导致图片被拉伸或裁到边角。
 */
export function createSquareImageProcessor({
  targetSize,
  maxBytes,
  fileName,
  makeError,
}: SquareImageOptions): SquareImageProcessor {
  const squareCrop = (
    width: number,
    height: number,
    target: number = targetSize
  ): SquareCrop => {
    if (!(width > 0) || !(height > 0)) {
      throw makeError('decode_failed')
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

  const loadDrawableImage = async (file: File): Promise<DrawableImage> => {
    // createImageBitmap 能直接解码，且会被浏览器按 EXIF 方向摆正：
    // 手机上竖拍的照片在这里已经是「正」的，省掉自己解析 EXIF。
    if (typeof createImageBitmap === 'function') {
      let bitmap: ImageBitmap
      try {
        bitmap = await createImageBitmap(file)
      } catch {
        throw makeError('decode_failed')
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
        image.onerror = () => reject(makeError('decode_failed'))
        image.src = objectUrl
      })
    } catch (error) {
      URL.revokeObjectURL(objectUrl)
      throw error
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
  const encodeSquare = async (
    source: DrawableImage,
    crop: SquareCrop
  ): Promise<Blob> => {
    const canvas = document.createElement('canvas')
    canvas.width = crop.output
    canvas.height = crop.output
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw makeError('encode_failed')
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
    if (png && png.size <= maxBytes) {
      return png
    }
    const jpeg = await toBlob('image/jpeg', JPEG_QUALITY)
    if (jpeg && jpeg.size <= maxBytes) {
      return jpeg
    }
    throw makeError('too_large')
  }

  /**
   * 把用户选中的文件处理成可直接上传的 PNG/JPEG。
   *
   * 非图片、浏览器解不出的格式（例如 Chrome 不支持的 HEIC）抛 `makeError`
   * 造出来的错误，调用方按 `code` 出提示。
   */
  const prepare = async (file: File): Promise<File> => {
    if (!file.type.startsWith('image/')) {
      throw makeError('not_image')
    }

    const source = await loadDrawableImage(file)
    try {
      const crop = squareCrop(source.width, source.height)
      const blob = await encodeSquare(source, crop)
      const extension = blob.type === 'image/png' ? 'png' : 'jpg'
      return new File([blob], fileName(extension), { type: blob.type })
    } finally {
      source.close()
    }
  }

  return { squareCrop, prepare }
}
