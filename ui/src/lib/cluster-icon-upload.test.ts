import { describe, expect, it } from 'vitest'

import {
  CLUSTER_ICON_MAX_BYTES,
  CLUSTER_ICON_MAX_DIMENSION,
  CLUSTER_ICON_TARGET_SIZE,
  ClusterIconUploadError,
  prepareClusterIconFile,
} from './cluster-icon-upload'

describe('prepareClusterIconFile', () => {
  it('非图片文件直接拒绝，不用走解码', async () => {
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })

    await expect(prepareClusterIconFile(file)).rejects.toMatchObject({
      code: 'cluster_icon_client_not_image',
    })
  })

  // 客户端错误码必须带 cluster_icon_ 前缀：translateError 按它映射到
  // clusterBadge.errors.*，否则界面会显示裸错误码。
  it('错误码用 cluster_icon_client_ 前缀，与服务端共用一套文案', async () => {
    const file = new File(['x'], 'note.bin', { type: '' })
    const error = await prepareClusterIconFile(file).catch((err) => err)

    expect(error).toBeInstanceOf(ClusterIconUploadError)
    expect((error as ClusterIconUploadError).code).toMatch(/^cluster_icon_/)
  })
})

describe('限制常量与服务端一致', () => {
  // 服务端上限写在 pkg/imageupload/imageupload.go（由 pkg/cluster 使用），
  // 改了任何一边都要同步（不一致的表现是「前端放行、后端 413/400」）。
  it('大小 1 MiB、边长 1024、目标边长 256', () => {
    expect(CLUSTER_ICON_MAX_BYTES).toBe(1 << 20)
    expect(CLUSTER_ICON_MAX_DIMENSION).toBe(1024)
    expect(CLUSTER_ICON_TARGET_SIZE).toBe(256)
  })
})
