import { describe, expect, it } from 'vitest'

import {
  AVATAR_MAX_BYTES,
  AVATAR_MAX_DIMENSION,
  AVATAR_TARGET_SIZE,
  AvatarUploadError,
  prepareAvatarFile,
  squareCrop,
} from './avatar-upload'

describe('squareCrop', () => {
  it('横图取中间的方形区域', () => {
    // 800×400：裁出中间的 400×400，再缩放到 400（小于目标 512，不放大）。
    expect(squareCrop(800, 400)).toEqual({
      sx: 200,
      sy: 0,
      size: 400,
      output: 400,
    })
  })

  it('竖图同样取中间的方形区域', () => {
    expect(squareCrop(400, 1000)).toEqual({
      sx: 0,
      sy: 300,
      size: 400,
      output: 400,
    })
  })

  it('大图缩放到目标边长', () => {
    expect(squareCrop(4000, 3000)).toEqual({
      sx: 500,
      sy: 0,
      size: 3000,
      output: AVATAR_TARGET_SIZE,
    })
  })

  it('小图不放大（避免糊掉）', () => {
    expect(squareCrop(64, 64).output).toBe(64)
  })

  it('奇数边长也落在整数像素上', () => {
    const crop = squareCrop(101, 51)
    expect(Number.isInteger(crop.sx)).toBe(true)
    expect(Number.isInteger(crop.sy)).toBe(true)
    expect(crop.size).toBe(51)
  })

  it('尺寸非法（解不出图）时报错', () => {
    expect(() => squareCrop(0, 100)).toThrowError(AvatarUploadError)
    expect(() => squareCrop(100, 0)).toThrowError(AvatarUploadError)
  })
})

describe('prepareAvatarFile', () => {
  it('非图片文件直接拒绝，不用走解码', async () => {
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })

    await expect(prepareAvatarFile(file)).rejects.toMatchObject({
      code: 'avatar_client_not_image',
    })
  })

  // 客户端错误码必须带 avatar_ 前缀：translateError 按它映射到
  // avatarUpload.errors.*，否则界面会显示裸错误码。
  it('错误码用 avatar_client_ 前缀，与服务端共用一套文案', async () => {
    const file = new File(['x'], 'note.bin', { type: '' })
    const error = await prepareAvatarFile(file).catch((err) => err)

    expect(error).toBeInstanceOf(AvatarUploadError)
    expect((error as AvatarUploadError).code).toMatch(/^avatar_/)
  })
})

describe('限制常量与服务端一致', () => {
  // 服务端的 maxAvatarBytes / maxAvatarDimension 写死在 pkg/users/avatar.go，
  // 改了任何一边都要同步（不一致的表现是「前端放行、后端 413/400」）。
  it('大小 1 MiB、边长 1024、目标边长 512', () => {
    expect(AVATAR_MAX_BYTES).toBe(1 << 20)
    expect(AVATAR_MAX_DIMENSION).toBe(1024)
    expect(AVATAR_TARGET_SIZE).toBe(512)
  })
})
