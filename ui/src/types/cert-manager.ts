import { ObjectMeta } from 'kubernetes-types/meta/v1'

export interface Certificate {
  apiVersion?: 'cert-manager.io/v1'
  kind?: 'Certificate'
  metadata?: ObjectMeta
  spec?: CertificateSpec
}

export interface CertificateSpec {
  /** secretName 是签发结果 TLS 证书落盘的 Secret 名称。 */
  secretName?: string
  /** issuerRef 引用负责签发的 Issuer / ClusterIssuer。 */
  issuerRef?: IssuerReference
  /** dnsNames 是证书需要覆盖的 DNS 域名列表。 */
  dnsNames?: string[]
  /** duration 是证书有效期（如 2160h）。 */
  duration?: string
  /** renewBefore 是距过期多久开始续期（如 360h）。 */
  renewBefore?: string
}

export interface IssuerReference {
  /** group 是 Issuer 的 API 组，ClusterIssuer 与 Issuer 一致为 cert-manager.io。 */
  group?: string
  /** kind 是 Issuer 或 ClusterIssuer。 */
  kind?: string
  /** name 是签发者名称。 */
  name: string
}

export interface CertificateRequest {
  apiVersion?: 'cert-manager.io/v1'
  kind?: 'CertificateRequest'
  metadata?: ObjectMeta
  spec?: { issuerRef?: IssuerReference }
}

export interface Issuer {
  apiVersion?: 'cert-manager.io/v1'
  kind?: 'Issuer'
  metadata?: ObjectMeta
  spec?: { acme?: ACMEIssuer }
}

export interface ClusterIssuer {
  apiVersion?: 'cert-manager.io/v1'
  kind?: 'ClusterIssuer'
  metadata?: ObjectMeta
  spec?: { acme?: ACMEIssuer }
}

export interface ACMEIssuer {
  /** server 是 ACME 服务端点。 */
  server?: string
  /** email 是注册使用的联系邮箱。 */
  email?: string
}

export interface Order {
  apiVersion?: 'acme.cert-manager.io/v1'
  kind?: 'Order'
  metadata?: ObjectMeta
  spec?: { commonName?: string; dnsNames?: string[] }
}

export interface Challenge {
  apiVersion?: 'acme.cert-manager.io/v1'
  kind?: 'Challenge'
  metadata?: ObjectMeta
  spec?: { dnsName?: string; type?: string; token?: string }
}

export interface CertificateList {
  items: Certificate[]
  metadata?: { resourceVersion?: string; continue?: string }
}

export interface CertificateRequestList {
  items: CertificateRequest[]
  metadata?: { resourceVersion?: string; continue?: string }
}

export interface IssuerList {
  items: Issuer[]
  metadata?: { resourceVersion?: string; continue?: string }
}

export interface ClusterIssuerList {
  items: ClusterIssuer[]
  metadata?: { resourceVersion?: string; continue?: string }
}

export interface OrderList {
  items: Order[]
  metadata?: { resourceVersion?: string; continue?: string }
}

export interface ChallengeList {
  items: Challenge[]
  metadata?: { resourceVersion?: string; continue?: string }
}
