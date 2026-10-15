import { deleteResource } from '@/lib/api'

/**
 * 删除工作负载时联动清理的关联 Service。
 * 404（已被并发删除）按成功处理；其余失败以名字返回，
 * 由调用方负责把失败名单提示给操作者。
 */
export async function deleteRelatedServices(
  names: string[],
  namespace?: string
): Promise<string[]> {
  const results = await Promise.allSettled(
    names.map((svcName) => deleteResource('services', svcName, namespace))
  )
  return names.filter((_, i) => {
    const result = results[i]
    if (result.status === 'fulfilled') return false
    const message = String(
      (result.reason as { response?: { data?: { error?: string } } })?.response
        ?.data?.error ?? result.reason
    ).toLowerCase()
    return !(message.includes('not found') || message.includes('404'))
  })
}
