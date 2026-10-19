import {
  IconArrowsHorizontal,
  IconBell,
  IconBox,
  IconBoxMultiple,
  IconCertificate,
  IconClockHour4,
  IconCode,
  IconDatabase,
  IconFileDatabase,
  IconKey,
  IconLoadBalancer,
  IconLock,
  IconMap,
  IconNetwork,
  IconPackage,
  IconPlayerPlay,
  IconRocket,
  IconRoute,
  IconRouter,
  IconServer2,
  IconShield,
  IconShieldCheck,
  IconStack2,
  IconTopologyBus,
  IconUser,
  IconUsers,
} from '@tabler/icons-react'

type SidebarGroupKey =
  | 'sidebar.groups.cluster'
  | 'sidebar.groups.workloads'
  | 'sidebar.groups.traffic'
  | 'sidebar.groups.storage'
  | 'sidebar.groups.config'
  | 'sidebar.groups.security'
  | 'sidebar.groups.certmanager'
  | 'sidebar.groups.other'
  | 'sidebar.groups.application'
  | 'sidebar.groups.infrastructure'

export const resourceIconMap = {
  IconBox,
  IconRocket,
  IconStack2,
  IconTopologyBus,
  IconPackage,
  IconPlayerPlay,
  IconClockHour4,
  IconRouter,
  IconShield,
  IconNetwork,
  IconLoadBalancer,
  IconRoute,
  IconFileDatabase,
  IconDatabase,
  IconMap,
  IconLock,
  IconArrowsHorizontal,
  IconUser,
  IconUsers,
  IconShieldCheck,
  IconKey,
  IconBoxMultiple,
  IconServer2,
  IconBell,
  IconCode,
  IconCertificate,
} as const

export type ResourceIconName = keyof typeof resourceIconMap

interface ResourceCatalogEntryBase {
  type: string
  singular: string
  singularLabel: string
  pluralLabel: string
  /** YAML 里的 kind。仅当它无法由 singular / singularLabel 推导时填写。 */
  kind?: string
  shortLabel?: string
  clusterScope: boolean
  titleKey?: string
  icon?: ResourceIconName
  sidebar?: {
    groupKey: SidebarGroupKey
    order: number
    titleKey?: string
    defaultHidden?: boolean
  }
}

export const sidebarGroupOrder = [
  // 「集群」放最前：节点 / 命名空间 / 事件是集群级通用入口，比业务资源更常用。
  'sidebar.groups.cluster',
  'sidebar.groups.workloads',
  'sidebar.groups.traffic',
  'sidebar.groups.storage',
  'sidebar.groups.config',
  'sidebar.groups.infrastructure',
  'sidebar.groups.security',
  'sidebar.groups.certmanager',
  'sidebar.groups.other',
  // 「应用」（Helm）放到最底下。
  'sidebar.groups.application',
] as const satisfies readonly SidebarGroupKey[]

export const resourceCatalog = [
  {
    type: 'pods',
    singular: 'pod',
    singularLabel: 'Pod',
    pluralLabel: 'Pods',
    clusterScope: false,
    titleKey: 'nav.pods',
    icon: 'IconBox',
    sidebar: { groupKey: 'sidebar.groups.workloads', order: 0 },
  },
  {
    type: 'deployments',
    singular: 'deployment',
    singularLabel: 'Deployment',
    pluralLabel: 'Deployments',
    shortLabel: 'Deploy',
    clusterScope: false,
    titleKey: 'nav.deployments',
    icon: 'IconRocket',
    sidebar: { groupKey: 'sidebar.groups.workloads', order: 1 },
  },
  {
    type: 'statefulsets',
    singular: 'statefulset',
    singularLabel: 'StatefulSet',
    pluralLabel: 'StatefulSets',
    shortLabel: 'STS',
    clusterScope: false,
    titleKey: 'nav.statefulsets',
    icon: 'IconStack2',
    sidebar: { groupKey: 'sidebar.groups.workloads', order: 2 },
  },
  {
    type: 'daemonsets',
    singular: 'daemonset',
    singularLabel: 'DaemonSet',
    pluralLabel: 'DaemonSets',
    shortLabel: 'Daemon',
    clusterScope: false,
    titleKey: 'nav.daemonsets',
    icon: 'IconTopologyBus',
    sidebar: { groupKey: 'sidebar.groups.workloads', order: 3 },
  },
  {
    type: 'jobs',
    singular: 'job',
    singularLabel: 'Job',
    pluralLabel: 'Jobs',
    shortLabel: 'Job',
    clusterScope: false,
    titleKey: 'nav.jobs',
    icon: 'IconPlayerPlay',
    sidebar: { groupKey: 'sidebar.groups.workloads', order: 4 },
  },
  {
    type: 'cronjobs',
    singular: 'cronjob',
    singularLabel: 'CronJob',
    pluralLabel: 'CronJobs',
    clusterScope: false,
    titleKey: 'nav.cronjobs',
    icon: 'IconClockHour4',
    sidebar: { groupKey: 'sidebar.groups.workloads', order: 5 },
  },
  {
    type: 'services',
    singular: 'service',
    singularLabel: 'Service',
    pluralLabel: 'Services',
    clusterScope: false,
    titleKey: 'nav.services',
    icon: 'IconNetwork',
    sidebar: { groupKey: 'sidebar.groups.traffic', order: 2 },
  },
  {
    type: 'gateways',
    singular: 'gateway',
    singularLabel: 'Gateway',
    pluralLabel: 'Gateways',
    clusterScope: false,
    titleKey: 'nav.gateways',
    icon: 'IconLoadBalancer',
    sidebar: { groupKey: 'sidebar.groups.traffic', order: 3 },
  },
  {
    type: 'httproutes',
    singular: 'httproute',
    singularLabel: 'HTTPRoute',
    pluralLabel: 'HTTPRoutes',
    clusterScope: false,
    titleKey: 'nav.httproutes',
    icon: 'IconRoute',
    sidebar: { groupKey: 'sidebar.groups.traffic', order: 4 },
  },
  {
    type: 'certificates',
    singular: 'certificate',
    singularLabel: 'Certificate',
    pluralLabel: 'Certificates',
    clusterScope: false,
    titleKey: 'nav.certificates',
    icon: 'IconCertificate',
    sidebar: { groupKey: 'sidebar.groups.certmanager', order: 0 },
  },
  {
    type: 'certificaterequests',
    singular: 'certificaterequest',
    singularLabel: 'CertificateRequest',
    pluralLabel: 'CertificateRequests',
    clusterScope: false,
    titleKey: 'nav.certificaterequests',
    icon: 'IconCertificate',
    sidebar: {
      groupKey: 'sidebar.groups.certmanager',
      order: 1,
      defaultHidden: true,
    },
  },
  {
    type: 'issuers',
    singular: 'issuer',
    singularLabel: 'Issuer',
    pluralLabel: 'Issuers',
    clusterScope: false,
    titleKey: 'nav.issuers',
    icon: 'IconShieldCheck',
    sidebar: { groupKey: 'sidebar.groups.certmanager', order: 2 },
  },
  {
    type: 'clusterissuers',
    singular: 'clusterissuer',
    singularLabel: 'ClusterIssuer',
    pluralLabel: 'ClusterIssuers',
    clusterScope: true,
    titleKey: 'nav.clusterissuers',
    icon: 'IconShieldCheck',
    sidebar: { groupKey: 'sidebar.groups.certmanager', order: 3 },
  },
  {
    type: 'orders',
    singular: 'order',
    singularLabel: 'Order',
    pluralLabel: 'Orders',
    clusterScope: false,
    titleKey: 'nav.orders',
    icon: 'IconCertificate',
    sidebar: {
      groupKey: 'sidebar.groups.certmanager',
      order: 4,
      defaultHidden: true,
    },
  },
  {
    type: 'challenges',
    singular: 'challenge',
    singularLabel: 'Challenge',
    pluralLabel: 'Challenges',
    clusterScope: false,
    titleKey: 'nav.challenges',
    icon: 'IconCertificate',
    sidebar: {
      groupKey: 'sidebar.groups.certmanager',
      order: 5,
      defaultHidden: true,
    },
  },
  {
    type: 'configmaps',
    singular: 'configmap',
    singularLabel: 'ConfigMap',
    pluralLabel: 'ConfigMaps',
    clusterScope: false,
    titleKey: 'nav.configMaps',
    icon: 'IconMap',
    sidebar: { groupKey: 'sidebar.groups.config', order: 0 },
  },
  {
    type: 'secrets',
    singular: 'secret',
    singularLabel: 'Secret',
    pluralLabel: 'Secrets',
    clusterScope: false,
    titleKey: 'nav.secrets',
    icon: 'IconLock',
    sidebar: { groupKey: 'sidebar.groups.config', order: 1 },
  },
  {
    type: 'ingresses',
    singular: 'ingress',
    singularLabel: 'Ingress',
    pluralLabel: 'Ingresses',
    clusterScope: false,
    titleKey: 'nav.ingresses',
    icon: 'IconRouter',
    sidebar: { groupKey: 'sidebar.groups.traffic', order: 0 },
  },
  {
    type: 'networkpolicies',
    singular: 'networkpolicy',
    singularLabel: 'NetworkPolicy',
    pluralLabel: 'NetworkPolicies',
    clusterScope: false,
    titleKey: 'nav.networkpolicies',
    icon: 'IconShield',
    sidebar: { groupKey: 'sidebar.groups.traffic', order: 1 },
  },
  {
    type: 'namespaces',
    singular: 'namespace',
    singularLabel: 'Namespace',
    pluralLabel: 'Namespaces',
    clusterScope: true,
    titleKey: 'nav.namespaces',
    icon: 'IconBoxMultiple',
    sidebar: { groupKey: 'sidebar.groups.cluster', order: 1 },
  },
  {
    type: 'crds',
    singular: 'crd',
    singularLabel: 'CRD',
    // 反查作用域要用 YAML 里真正的 kind，而不是缩写。
    kind: 'CustomResourceDefinition',
    pluralLabel: 'CRDs',
    clusterScope: true,
    titleKey: 'nav.crds',
    icon: 'IconCode',
    sidebar: { groupKey: 'sidebar.groups.infrastructure', order: 4 },
  },
  {
    type: 'crs',
    singular: 'custom resource',
    singularLabel: 'Custom Resource',
    pluralLabel: 'Custom Resources',
    clusterScope: false,
    titleKey: 'nav.customResources',
    icon: 'IconCode',
  },
  {
    type: 'endpoints',
    singular: 'endpoints',
    singularLabel: 'Endpoints',
    pluralLabel: 'Endpoints',
    clusterScope: false,
    titleKey: 'nav.endpoints',
    icon: 'IconNetwork',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 10,
      defaultHidden: true,
    },
  },
  {
    type: 'endpointslices',
    singular: 'endpointslice',
    singularLabel: 'EndpointSlice',
    pluralLabel: 'EndpointSlices',
    clusterScope: false,
    titleKey: 'nav.endpointslices',
    icon: 'IconNetwork',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 11,
      defaultHidden: true,
    },
  },
  {
    type: 'podtemplates',
    singular: 'podtemplate',
    singularLabel: 'PodTemplate',
    pluralLabel: 'PodTemplates',
    clusterScope: false,
    titleKey: 'nav.podtemplates',
    icon: 'IconBox',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 12,
      defaultHidden: true,
    },
  },
  {
    type: 'replicationcontrollers',
    singular: 'replicationcontroller',
    singularLabel: 'ReplicationController',
    pluralLabel: 'ReplicationControllers',
    shortLabel: 'RC',
    clusterScope: false,
    titleKey: 'nav.replicationcontrollers',
    icon: 'IconBox',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 13,
      defaultHidden: true,
    },
  },
  {
    type: 'limitranges',
    singular: 'limitrange',
    singularLabel: 'LimitRange',
    pluralLabel: 'LimitRanges',
    clusterScope: false,
    titleKey: 'nav.limitranges',
    icon: 'IconArrowsHorizontal',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 14,
      defaultHidden: true,
    },
  },
  {
    type: 'resourcequotas',
    singular: 'resourcequota',
    singularLabel: 'ResourceQuota',
    pluralLabel: 'ResourceQuotas',
    clusterScope: false,
    titleKey: 'nav.resourcequotas',
    icon: 'IconDatabase',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 15,
      defaultHidden: true,
    },
  },
  {
    type: 'componentstatuses',
    singular: 'componentstatus',
    singularLabel: 'ComponentStatus',
    pluralLabel: 'ComponentStatuses',
    clusterScope: true,
    titleKey: 'nav.componentstatuses',
    icon: 'IconServer2',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 16,
      defaultHidden: true,
    },
  },
  {
    type: 'controllerrevisions',
    singular: 'controllerrevision',
    singularLabel: 'ControllerRevision',
    pluralLabel: 'ControllerRevisions',
    clusterScope: false,
    titleKey: 'nav.controllerrevisions',
    icon: 'IconStack2',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 17,
      defaultHidden: true,
    },
  },
  {
    type: 'ingressclasses',
    singular: 'ingressclass',
    singularLabel: 'IngressClass',
    pluralLabel: 'IngressClasses',
    clusterScope: true,
    titleKey: 'nav.ingressclasses',
    icon: 'IconRouter',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 18,
      defaultHidden: true,
    },
  },
  {
    type: 'ipaddresses',
    singular: 'ipaddress',
    singularLabel: 'IPAddress',
    pluralLabel: 'IPAddresses',
    clusterScope: true,
    titleKey: 'nav.ipaddresses',
    icon: 'IconNetwork',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 19,
      defaultHidden: true,
    },
  },
  {
    type: 'servicecidrs',
    singular: 'servicecidr',
    singularLabel: 'ServiceCIDR',
    pluralLabel: 'ServiceCIDRs',
    clusterScope: true,
    titleKey: 'nav.servicecidrs',
    icon: 'IconNetwork',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 20,
      defaultHidden: true,
    },
  },
  {
    type: 'volumeattachments',
    singular: 'volumeattachment',
    singularLabel: 'VolumeAttachment',
    pluralLabel: 'VolumeAttachments',
    clusterScope: true,
    titleKey: 'nav.volumeattachments',
    icon: 'IconDatabase',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 21,
      defaultHidden: true,
    },
  },
  {
    type: 'csidrivers',
    singular: 'csidriver',
    singularLabel: 'CSIDriver',
    pluralLabel: 'CSIDrivers',
    clusterScope: true,
    titleKey: 'nav.csidrivers',
    icon: 'IconDatabase',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 22,
      defaultHidden: true,
    },
  },
  {
    type: 'csinodes',
    singular: 'csinode',
    singularLabel: 'CSINode',
    pluralLabel: 'CSINodes',
    clusterScope: true,
    titleKey: 'nav.csinodes',
    icon: 'IconServer2',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 23,
      defaultHidden: true,
    },
  },
  {
    type: 'csistoragecapacities',
    singular: 'csistoragecapacity',
    singularLabel: 'CSIStorageCapacity',
    pluralLabel: 'CSIStorageCapacities',
    clusterScope: false,
    titleKey: 'nav.csistoragecapacities',
    icon: 'IconDatabase',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 24,
      defaultHidden: true,
    },
  },
  {
    type: 'volumeattributesclasses',
    singular: 'volumeattributesclass',
    singularLabel: 'VolumeAttributesClass',
    pluralLabel: 'VolumeAttributesClasses',
    clusterScope: true,
    titleKey: 'nav.volumeattributesclasses',
    icon: 'IconDatabase',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 25,
      defaultHidden: true,
    },
  },
  {
    type: 'certificatesigningrequests',
    singular: 'certificatesigningrequest',
    singularLabel: 'CertificateSigningRequest',
    pluralLabel: 'CertificateSigningRequests',
    shortLabel: 'CSR',
    clusterScope: true,
    titleKey: 'nav.certificatesigningrequests',
    icon: 'IconShieldCheck',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 26,
      defaultHidden: true,
    },
  },
  {
    type: 'clustertrustbundles',
    singular: 'clustertrustbundle',
    singularLabel: 'ClusterTrustBundle',
    pluralLabel: 'ClusterTrustBundles',
    clusterScope: true,
    titleKey: 'nav.clustertrustbundles',
    icon: 'IconShieldCheck',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 27,
      defaultHidden: true,
    },
  },
  {
    type: 'podcertificaterequests',
    singular: 'podcertificaterequest',
    singularLabel: 'PodCertificateRequest',
    pluralLabel: 'PodCertificateRequests',
    clusterScope: false,
    titleKey: 'nav.podcertificaterequests',
    icon: 'IconShield',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 28,
      defaultHidden: true,
    },
  },
  {
    type: 'leases',
    singular: 'lease',
    singularLabel: 'Lease',
    pluralLabel: 'Leases',
    clusterScope: false,
    titleKey: 'nav.leases',
    icon: 'IconClockHour4',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 29,
      defaultHidden: true,
    },
  },
  {
    type: 'leasecandidates',
    singular: 'leasecandidate',
    singularLabel: 'LeaseCandidate',
    pluralLabel: 'LeaseCandidates',
    clusterScope: false,
    titleKey: 'nav.leasecandidates',
    icon: 'IconClockHour4',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 30,
      defaultHidden: true,
    },
  },
  {
    type: 'runtimeclasses',
    singular: 'runtimeclass',
    singularLabel: 'RuntimeClass',
    pluralLabel: 'RuntimeClasses',
    clusterScope: true,
    titleKey: 'nav.runtimeclasses',
    icon: 'IconServer2',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 31,
      defaultHidden: true,
    },
  },
  {
    type: 'priorityclasses',
    singular: 'priorityclass',
    singularLabel: 'PriorityClass',
    pluralLabel: 'PriorityClasses',
    clusterScope: true,
    titleKey: 'nav.priorityclasses',
    icon: 'IconArrowsHorizontal',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 32,
      defaultHidden: true,
    },
  },
  {
    type: 'workloads',
    singular: 'workload',
    singularLabel: 'Workload',
    pluralLabel: 'Workloads',
    clusterScope: false,
    titleKey: 'nav.workloads',
    icon: 'IconBox',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 33,
      defaultHidden: true,
    },
  },
  {
    type: 'podgroups',
    singular: 'podgroup',
    singularLabel: 'PodGroup',
    pluralLabel: 'PodGroups',
    clusterScope: false,
    titleKey: 'nav.podgroups',
    icon: 'IconBoxMultiple',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 34,
      defaultHidden: true,
    },
  },
  {
    type: 'flowschemas',
    singular: 'flowschema',
    singularLabel: 'FlowSchema',
    pluralLabel: 'FlowSchemas',
    clusterScope: true,
    titleKey: 'nav.flowschemas',
    icon: 'IconRoute',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 35,
      defaultHidden: true,
    },
  },
  {
    type: 'prioritylevelconfigurations',
    singular: 'prioritylevelconfiguration',
    singularLabel: 'PriorityLevelConfiguration',
    pluralLabel: 'PriorityLevelConfigurations',
    clusterScope: true,
    titleKey: 'nav.prioritylevelconfigurations',
    icon: 'IconArrowsHorizontal',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 36,
      defaultHidden: true,
    },
  },
  {
    type: 'validatingadmissionpolicies',
    singular: 'validatingadmissionpolicy',
    singularLabel: 'ValidatingAdmissionPolicy',
    pluralLabel: 'ValidatingAdmissionPolicies',
    clusterScope: true,
    titleKey: 'nav.validatingadmissionpolicies',
    icon: 'IconShieldCheck',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 37,
      defaultHidden: true,
    },
  },
  {
    type: 'validatingadmissionpolicybindings',
    singular: 'validatingadmissionpolicybinding',
    singularLabel: 'ValidatingAdmissionPolicyBinding',
    pluralLabel: 'ValidatingAdmissionPolicyBindings',
    clusterScope: true,
    titleKey: 'nav.validatingadmissionpolicybindings',
    icon: 'IconShieldCheck',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 38,
      defaultHidden: true,
    },
  },
  {
    type: 'validatingwebhookconfigurations',
    singular: 'validatingwebhookconfiguration',
    singularLabel: 'ValidatingWebhookConfiguration',
    pluralLabel: 'ValidatingWebhookConfigurations',
    clusterScope: true,
    titleKey: 'nav.validatingwebhookconfigurations',
    icon: 'IconShieldCheck',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 39,
      defaultHidden: true,
    },
  },
  {
    type: 'mutatingwebhookconfigurations',
    singular: 'mutatingwebhookconfiguration',
    singularLabel: 'MutatingWebhookConfiguration',
    pluralLabel: 'MutatingWebhookConfigurations',
    clusterScope: true,
    titleKey: 'nav.mutatingwebhookconfigurations',
    icon: 'IconShield',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 40,
      defaultHidden: true,
    },
  },
  {
    type: 'mutatingadmissionpolicies',
    singular: 'mutatingadmissionpolicy',
    singularLabel: 'MutatingAdmissionPolicy',
    pluralLabel: 'MutatingAdmissionPolicies',
    clusterScope: true,
    titleKey: 'nav.mutatingadmissionpolicies',
    icon: 'IconShield',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 41,
      defaultHidden: true,
    },
  },
  {
    type: 'mutatingadmissionpolicybindings',
    singular: 'mutatingadmissionpolicybinding',
    singularLabel: 'MutatingAdmissionPolicyBinding',
    pluralLabel: 'MutatingAdmissionPolicyBindings',
    clusterScope: true,
    titleKey: 'nav.mutatingadmissionpolicybindings',
    icon: 'IconShield',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 42,
      defaultHidden: true,
    },
  },
  {
    type: 'resourceslices',
    singular: 'resourceslice',
    singularLabel: 'ResourceSlice',
    pluralLabel: 'ResourceSlices',
    clusterScope: true,
    titleKey: 'nav.resourceslices',
    icon: 'IconDatabase',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 43,
      defaultHidden: true,
    },
  },
  {
    type: 'resourceclaims',
    singular: 'resourceclaim',
    singularLabel: 'ResourceClaim',
    pluralLabel: 'ResourceClaims',
    clusterScope: false,
    titleKey: 'nav.resourceclaims',
    icon: 'IconDatabase',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 44,
      defaultHidden: true,
    },
  },
  {
    type: 'deviceclasses',
    singular: 'deviceclass',
    singularLabel: 'DeviceClass',
    pluralLabel: 'DeviceClasses',
    clusterScope: true,
    titleKey: 'nav.deviceclasses',
    icon: 'IconPackage',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 45,
      defaultHidden: true,
    },
  },
  {
    type: 'resourceclaimtemplates',
    singular: 'resourceclaimtemplate',
    singularLabel: 'ResourceClaimTemplate',
    pluralLabel: 'ResourceClaimTemplates',
    clusterScope: false,
    titleKey: 'nav.resourceclaimtemplates',
    icon: 'IconFileDatabase',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 46,
      defaultHidden: true,
    },
  },
  {
    type: 'devicetaintrules',
    singular: 'devicetaintrule',
    singularLabel: 'DeviceTaintRule',
    pluralLabel: 'DeviceTaintRules',
    clusterScope: true,
    titleKey: 'nav.devicetaintrules',
    icon: 'IconShield',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 47,
      defaultHidden: true,
    },
  },
  {
    type: 'resourcepoolstatusrequests',
    singular: 'resourcepoolstatusrequest',
    singularLabel: 'ResourcePoolStatusRequest',
    pluralLabel: 'ResourcePoolStatusRequests',
    clusterScope: true,
    titleKey: 'nav.resourcepoolstatusrequests',
    icon: 'IconDatabase',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 48,
      defaultHidden: true,
    },
  },
  {
    type: 'storageversions',
    singular: 'storageversion',
    singularLabel: 'StorageVersion',
    pluralLabel: 'StorageVersions',
    clusterScope: true,
    titleKey: 'nav.storageversions',
    icon: 'IconDatabase',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 49,
      defaultHidden: true,
    },
  },
  {
    type: 'storageversionmigrations',
    singular: 'storageversionmigration',
    singularLabel: 'StorageVersionMigration',
    pluralLabel: 'StorageVersionMigrations',
    clusterScope: true,
    titleKey: 'nav.storageversionmigrations',
    icon: 'IconDatabase',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 50,
      defaultHidden: true,
    },
  },
  {
    type: 'nodes',
    singular: 'node',
    singularLabel: 'Node',
    pluralLabel: 'Nodes',
    clusterScope: true,
    titleKey: 'nav.nodes',
    icon: 'IconServer2',
    sidebar: { groupKey: 'sidebar.groups.cluster', order: 0 },
  },
  {
    type: 'events',
    singular: 'event',
    singularLabel: 'Event',
    pluralLabel: 'Events',
    clusterScope: false,
    titleKey: 'nav.events',
    icon: 'IconBell',
    sidebar: { groupKey: 'sidebar.groups.cluster', order: 2 },
  },
  {
    type: 'persistentvolumes',
    singular: 'persistentvolume',
    singularLabel: 'PersistentVolume',
    pluralLabel: 'PersistentVolumes',
    shortLabel: 'PV',
    clusterScope: true,
    titleKey: 'nav.persistentvolumes',
    icon: 'IconDatabase',
    sidebar: {
      groupKey: 'sidebar.groups.infrastructure',
      order: 2,
      titleKey: 'sidebar.short.pvs',
    },
  },
  {
    type: 'persistentvolumeclaims',
    singular: 'persistentvolumeclaim',
    singularLabel: 'PersistentVolumeClaim',
    pluralLabel: 'PersistentVolumeClaims',
    shortLabel: 'PVC',
    clusterScope: false,
    titleKey: 'nav.persistentvolumeclaims',
    icon: 'IconFileDatabase',
    sidebar: {
      groupKey: 'sidebar.groups.storage',
      order: 0,
      titleKey: 'sidebar.short.pvcs',
    },
  },
  {
    type: 'storageclasses',
    singular: 'storageclass',
    singularLabel: 'StorageClass',
    pluralLabel: 'StorageClasses',
    clusterScope: true,
    titleKey: 'nav.storageclasses',
    icon: 'IconFileDatabase',
    sidebar: { groupKey: 'sidebar.groups.infrastructure', order: 3 },
  },
  {
    type: 'podmetrics',
    singular: 'podmetric',
    singularLabel: 'PodMetrics',
    pluralLabel: 'PodMetrics',
    clusterScope: false,
    icon: 'IconBox',
  },
  {
    type: 'replicasets',
    singular: 'replicaset',
    singularLabel: 'ReplicaSet',
    pluralLabel: 'ReplicaSets',
    clusterScope: false,
    titleKey: 'nav.replicasets',
    icon: 'IconBox',
    sidebar: {
      groupKey: 'sidebar.groups.other',
      order: 51,
      defaultHidden: true,
    },
  },
  {
    type: 'serviceaccounts',
    singular: 'serviceaccount',
    singularLabel: 'ServiceAccount',
    pluralLabel: 'ServiceAccounts',
    shortLabel: 'SA',
    clusterScope: false,
    titleKey: 'nav.serviceaccounts',
    icon: 'IconUser',
    sidebar: { groupKey: 'sidebar.groups.security', order: 0 },
  },
  {
    type: 'roles',
    singular: 'role',
    singularLabel: 'Role',
    pluralLabel: 'Roles',
    clusterScope: false,
    titleKey: 'nav.roles',
    icon: 'IconShield',
    sidebar: { groupKey: 'sidebar.groups.security', order: 1 },
  },
  {
    type: 'rolebindings',
    singular: 'rolebinding',
    singularLabel: 'RoleBinding',
    pluralLabel: 'RoleBindings',
    clusterScope: false,
    titleKey: 'nav.rolebindings',
    icon: 'IconUsers',
    sidebar: { groupKey: 'sidebar.groups.security', order: 2 },
  },
  {
    type: 'clusterroles',
    singular: 'clusterrole',
    singularLabel: 'ClusterRole',
    pluralLabel: 'ClusterRoles',
    clusterScope: true,
    titleKey: 'nav.clusterroles',
    icon: 'IconShieldCheck',
    sidebar: { groupKey: 'sidebar.groups.security', order: 3 },
  },
  {
    type: 'clusterrolebindings',
    singular: 'clusterrolebinding',
    singularLabel: 'ClusterRoleBinding',
    pluralLabel: 'ClusterRoleBindings',
    clusterScope: true,
    titleKey: 'nav.clusterrolebindings',
    icon: 'IconKey',
    sidebar: { groupKey: 'sidebar.groups.security', order: 4 },
  },
  {
    type: 'horizontalpodautoscalers',
    singular: 'horizontalpodautoscaler',
    singularLabel: 'HorizontalPodAutoscaler',
    pluralLabel: 'HorizontalPodAutoscalers',
    shortLabel: 'HPA',
    clusterScope: false,
    titleKey: 'nav.horizontalpodautoscalers',
    icon: 'IconArrowsHorizontal',
    sidebar: { groupKey: 'sidebar.groups.config', order: 2 },
  },
  {
    type: 'poddisruptionbudgets',
    singular: 'poddisruptionbudget',
    singularLabel: 'PodDisruptionBudget',
    pluralLabel: 'PodDisruptionBudgets',
    shortLabel: 'PDB',
    clusterScope: false,
    titleKey: 'nav.poddisruptionbudgets',
    icon: 'IconShield',
    sidebar: { groupKey: 'sidebar.groups.config', order: 3 },
  },
  {
    type: 'helmrelease',
    singular: 'helmrelease',
    singularLabel: 'Helm Release',
    pluralLabel: 'Helm Releases',
    clusterScope: false,
    titleKey: 'nav.helmReleases',
    icon: 'IconPackage',
    sidebar: { groupKey: 'sidebar.groups.application', order: 0 },
  },
] as const satisfies readonly ResourceCatalogEntryBase[]

export type CatalogResourceType = (typeof resourceCatalog)[number]['type']

export type ResourceType = CatalogResourceType

export type ResourceMetadata = Omit<ResourceCatalogEntryBase, 'type'> & {
  type: ResourceType
}

export const resourceMetadataList: readonly ResourceMetadata[] =
  resourceCatalog.map((item) => ({
    type: item.type,
    singular: item.singular,
    singularLabel: item.singularLabel,
    pluralLabel: item.pluralLabel,
    shortLabel: 'shortLabel' in item ? item.shortLabel : undefined,
    clusterScope: item.clusterScope,
    titleKey: 'titleKey' in item ? item.titleKey : undefined,
    icon: 'icon' in item ? item.icon : undefined,
    sidebar: 'sidebar' in item ? item.sidebar : undefined,
  }))

const resourceCatalogMap = new Map(
  resourceCatalog.map((item) => [item.type, item] as const)
)

const resourceMetadataMap = new Map(
  resourceMetadataList.flatMap((item) =>
    [item.type, item.singular, item.singularLabel, item.pluralLabel]
      .concat(item.shortLabel ? [item.shortLabel] : [])
      .map((alias) => [alias.toLowerCase(), item] as const)
  )
)

export function getResourceCatalogEntry(resource?: string | null) {
  if (!resource) {
    return undefined
  }
  return resourceCatalogMap.get(resource as CatalogResourceType)
}

export function getResourceMetadata(resource?: string | null) {
  if (!resource) {
    return undefined
  }
  return (
    resourceMetadataMap.get(resource.toLowerCase()) ??
    fallbackMetadata(resource)
  )
}

export function getResourceSingular(resource?: string | null) {
  return getResourceMetadata(resource)?.singular || ''
}

export function getResourceSingularLabel(resource?: string | null) {
  return getResourceMetadata(resource)?.singularLabel || ''
}

export function getResourcePluralLabel(resource?: string | null) {
  return getResourceMetadata(resource)?.pluralLabel || ''
}

export function getResourceShortLabel(resource?: string | null) {
  const metadata = getResourceMetadata(resource)
  return metadata?.shortLabel || metadata?.singularLabel || ''
}

export function isClusterScopedResource(resource?: string | null) {
  return getResourceMetadata(resource)?.clusterScope ?? false
}

/**
 * 集群级资源的 Kind（YAML 里的 kind）集合。列表页按资源类型（复数）判定作用域，
 * 但通用 YAML apply 只能看到 Kind，所以从目录里按 singular / singularLabel 反查，
 * 缩写与 Kind 不一致的条目由 kind 显式给出（如 CRD）。
 * 目录里没有的 Kind 一律当作命名空间级：绝大多数 CR 都是，判错也只是多写一行
 * metadata.namespace（后端会按自己的 RESTMapping 清掉）。
 *
 * 目录是 as const（保留字面量类型），这里按基础类型读才能访问可选的 kind。
 */
const catalogEntries: readonly ResourceCatalogEntryBase[] = resourceCatalog

const clusterScopedKinds = new Set(
  catalogEntries
    .filter((item) => item.clusterScope)
    .flatMap((item) => [item.singular, item.singularLabel, item.kind ?? ''])
    .map((kind) => kind.toLowerCase())
    .filter((kind) => kind !== '')
)

export function isClusterScopedKind(kind?: string | null) {
  return !!kind && clusterScopedKinds.has(kind.toLowerCase())
}

/**
 * 按 YAML 的 kind 反查资源路由名（复数）。目录条目按 type / singular /
 * singularLabel / 显式 kind / pluralLabel 匹配，找不到时返回 undefined。
 */
export function getResourceTypeFromKind(kind?: string | null) {
  if (!kind) return undefined
  const normalized = kind.toLowerCase()
  return catalogEntries.find(
    (item) =>
      item.type === normalized ||
      item.singular === normalized ||
      item.singularLabel.toLowerCase() === normalized ||
      item.kind?.toLowerCase() === normalized ||
      item.pluralLabel.toLowerCase() === normalized
  )?.type
}

/**
 * 按 Kubernetes 的复数规则推导资源名（与 kubebuilder 生成 CRD 时的默认复数
 * 一致：s/x/z/ch/sh → +es，辅音 + y → ies，其余 +s）。目录里已有的类型应优先
 * 走 getResourceTypeFromKind（含不规则复数），这里只兜底自定义资源；CRD 的
 * 复数由作者定义，不合规则时仍可能拼错。
 */
export function pluralizeKind(kind: string) {
  const lower = kind.toLowerCase()
  if (/(?:s|x|z|ch|sh)$/.test(lower)) return `${lower}es`
  if (/[^aeiou]y$/.test(lower)) return `${lower.slice(0, -1)}ies`
  return `${lower}s`
}

export interface ResourceScopeSplit {
  namespaced: string[]
  clusterScoped: string[]
  hasWildcard: boolean
}

// splitResourcesByScope 把已授权的资源模式分成命名空间级与
// 集群级两组，便于界面（命名空间授权、角色编辑器）画出
// 后端所施加的边界：只有命名空间级资源会受到
// 角色命名空间列表的限制。
export function splitResourcesByScope(resources: string[]): ResourceScopeSplit {
  const namespaced: string[] = []
  const clusterScoped: string[] = []
  let hasWildcard = false
  for (const resource of resources) {
    if (resource === '*') {
      hasWildcard = true
      continue
    }
    if (isClusterScopedResource(resource)) {
      clusterScoped.push(resource)
    } else {
      namespaced.push(resource)
    }
  }
  return { namespaced, clusterScoped, hasWildcard }
}

export function getResourceListPath(resource: string) {
  return `/${resource}`
}

export function getResourceDetailPath(
  resource: string,
  name: string,
  namespace?: string
) {
  return isClusterScopedResource(resource) || !namespace
    ? `/${resource}/${name}`
    : `/${resource}/${namespace}/${name}`
}

/**
 * 有可视化表单编辑页的资源类型。列表行操作菜单与详情页标题栏据此决定要不要给出
 * 「编辑」入口，路径模板也由这里推导，避免两处各写一份、改路由时漏掉一处静默 404。
 * 新增表单编辑页（`routes.tsx` 里的 `:resource/.../:name/edit`）时要同步这里，
 * 否则那些资源只剩详情页的 YAML 一条改法（resource-catalog.test.ts 会在漏同步时报错）。
 */
export const formEditableResourceTypes = [
  'deployments',
  'statefulsets',
  'daemonsets',
  'jobs',
  'cronjobs',
  'pods',
  'services',
  'configmaps',
  'secrets',
  'persistentvolumes',
  'storageclasses',
] as const

const formEditableResources = new Set<string>(formEditableResourceTypes)

export function hasResourceFormEdit(resource?: string | null) {
  return !!resource && formEditableResources.has(resource)
}

/** 没有表单编辑页时返回 undefined（调用方据此不渲染编辑入口）。 */
export function getResourceFormEditPath(
  resource: string,
  name: string,
  namespace?: string
) {
  if (!hasResourceFormEdit(resource)) {
    return undefined
  }
  const segment = encodeURIComponent(name)
  // 集群级资源（PV / StorageClass）的编辑路由没有命名空间段。
  return isClusterScopedResource(resource) || !namespace
    ? `/${resource}/${segment}/edit`
    : `/${resource}/${encodeURIComponent(namespace)}/${segment}/edit`
}

export function getResourceQueryKey(
  resource: string,
  namespace?: string,
  name?: string,
  cluster?: string | null
) {
  return [resource, namespace || '_all', name || '_all', cluster || '']
}

export const clusterScopedResourceTypes = resourceMetadataList
  .filter((item) => item.clusterScope)
  .map((item) => item.type) as ResourceType[]

function fallbackMetadata(resource: string): ResourceMetadata {
  const singular = resource.endsWith('s') ? resource.slice(0, -1) : resource
  const label = singular.charAt(0).toUpperCase() + singular.slice(1)
  return {
    type: resource as ResourceType,
    singular,
    singularLabel: label,
    pluralLabel: resource.charAt(0).toUpperCase() + resource.slice(1),
    clusterScope: false,
  }
}

export function getResourceIconComponent(iconName?: string) {
  return resourceIconMap[iconName as ResourceIconName] || IconBox
}
