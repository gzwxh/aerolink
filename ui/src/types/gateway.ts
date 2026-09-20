import { ObjectMeta } from 'kubernetes-types/meta/v1'

export interface Gateway {
  /** APIVersion 定义该对象表示的版本化 schema。服务器应把可识别的 schema 转换为最新的内部值，并可能拒绝不可识别的值。更多信息：https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#resources */
  apiVersion?: 'gateway.networking.k8s.io/v1'
  /** Kind 是表示该对象所对应 REST 资源的字符串值。服务器可以从客户端提交请求的端点推断出来。不可更新。使用驼峰命名。更多信息：https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#types-kinds */
  kind?: 'Gateway'
  /** 标准的对象元数据。更多信息：https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#metadata */
  metadata?: ObjectMeta
  /** spec 是 Ingress 的期望状态。更多信息：https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#spec-and-status */
  spec?: GatewaySpec
}

export interface GatewaySpec {
  /** gatewayClassName 是该 Gateway 使用的 GatewayClass 名称。该字段不可变。 */
  gatewayClassName?: string
}

export interface HTTPRoute {
  /** APIVersion 定义该对象表示的版本化 schema。服务器应把可识别的 schema 转换为最新的内部值，并可能拒绝不可识别的值。更多信息：https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#resources */
  apiVersion?: 'gateway.networking.k8s.io/v1'
  /** Kind 是表示该对象所对应 REST 资源的字符串值。服务器可以从客户端提交请求的端点推断出来。不可更新。使用驼峰命名。更多信息：https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#types-kinds */
  kind?: 'HTTPRoute'
  /** 标准的对象元数据。更多信息：https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#metadata */
  metadata?: ObjectMeta
  /** spec 是 HTTPRoute 的期望状态。更多信息：https://git.k8s.io/community/contributors/devel/sig-architecture/api-conventions.md#spec-and-status */
  spec?: HTTPRouteSpec
}

export interface HTTPRouteSpec {
  /** hostnames 是该 HTTPRoute 匹配的主机名列表。为空时，该 HTTPRoute 匹配所有主机名。 */
  hostnames?: string[]
  /** parentRefs 是该 HTTPRoute 所挂载到的 Gateway 引用列表。 */
  parentRefs?: {
    /** name 是该 HTTPRoute 所挂载到的 Gateway 名称。 */
    name: string
    /** namespace 是该 HTTPRoute 所挂载到的 Gateway 所在命名空间。未指定时，假定 Gateway 与该 HTTPRoute 在同一命名空间。 */
    namespace?: string
    /** sectionName 是该 HTTPRoute 所挂载到的 Gateway 内部区段名称。未指定时，该 HTTPRoute 挂载到 Gateway 的默认区段。 */
    sectionName?: string
  }[]
}
