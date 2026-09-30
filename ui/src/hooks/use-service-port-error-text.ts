import { useTranslation } from 'react-i18next'

import type { ServicePortErrorCode } from '@/lib/service-yaml'
import { useNodePortRange } from '@/hooks/use-node-port-range'

/**
 * 端口行的错误码 → 文案。
 *
 * 行内提示与提交前的错误横幅都要用，放一处免得两边各写一份措辞。NodePort 的文案按集群
 * 真实范围插值（拿不到范围时不会产生该错误码，见 `lib/service-yaml.ts` 的
 * `servicePortErrorCodes`）。
 */
export function useServicePortErrorText(): (
  code: ServicePortErrorCode
) => string {
  const { t } = useTranslation()
  const nodePortRange = useNodePortRange()

  return (code: ServicePortErrorCode) => {
    switch (code) {
      case 'port':
        return t('serviceCreate.portRangeError', '端口必须为 1-65535 的数字')
      case 'targetPortName':
        return t(
          'serviceCreate.targetPortNameError',
          '目标端口要么是 1-65535 的数字，要么是合法的端口名（小写字母/数字/-，最长 15 个字符）'
        )
      case 'targetPortRange':
        return t('serviceCreate.targetPortRangeError', '目标端口必须为 1-65535')
      case 'nodePortRange':
        return t('serviceCreate.nodePortRangeError', {
          min: nodePortRange?.min,
          max: nodePortRange?.max,
          defaultValue: `NodePort 必须为 ${nodePortRange?.min}-${nodePortRange?.max}`,
        })
    }
  }
}
