import { createBrowserRouter } from 'react-router-dom'

import App, { StandaloneAIChatApp } from './App'
import { ClusterNavigate } from './components/cluster-link'
import { InitCheckRoute } from './components/init-check-route'
import { LegacyClusterRedirect } from './components/legacy-cluster-redirect'
import { ProtectedRoute } from './components/protected-route'
import { getSubPath } from './lib/subpath'
import { AboutPage } from './pages/about-page'
import { AccountPage } from './pages/account-page'
import { ConfigMapCreatePage } from './pages/configmap-create-page'
import { CRListPage } from './pages/cr-list-page'
import { CronJobListPage } from './pages/cronjob-list-page'
import { DaemonSetListPage } from './pages/daemonset-list-page'
import { DeploymentCreatePage } from './pages/deployment-create-page'
import { DeploymentListPage } from './pages/deployment-list-page'
import { HelmChartDetailPage } from './pages/helm-chart-detail-page'
import { HelmChartListPage } from './pages/helm-chart-list-page'
import { InitializationPage } from './pages/initialization'
import { JobListPage } from './pages/job-list-page'
import { LoginPage } from './pages/login'
import { Overview } from './pages/overview'
import { PodListPage } from './pages/pod-list-page'
import { PVCreatePage } from './pages/pv-create-page'
import { RBACRedirect } from './pages/rbac'
import { ResourceDetail } from './pages/resource-detail'
import { ResourceList } from './pages/resource-list'
import { SecretCreatePage } from './pages/secret-create-page'
import { ServiceCreatePage } from './pages/service-create-page'
import { ServiceListPage } from './pages/service-list-page'
import { SettingsPage, SettingsRedirect } from './pages/settings'
import { StatefulSetListPage } from './pages/statefulset-list-page'
import { StorageClassCreatePage } from './pages/storageclass-create-page'

const subPath = getSubPath()

export const router = createBrowserRouter(
  [
    {
      path: '/setup',
      element: <InitializationPage />,
    },
    {
      path: '/login',
      element: (
        <InitCheckRoute allowIncompleteSetup>
          <LoginPage />
        </InitCheckRoute>
      ),
    },
    {
      // 全站业务页面统一挂在集群前缀下：/_clusters/<slug>/...
      // URL 是集群上下文的唯一事实源（方案：docs/dev/plans/2026-10-15-集群信息进入浏览器地址栏.md）。
      path: '/_clusters/:clusterSlug',
      element: (
        <InitCheckRoute>
          <ProtectedRoute>
            <App />
          </ProtectedRoute>
        </InitCheckRoute>
      ),
      children: [
        {
          index: true,
          element: <Overview />,
        },
        {
          path: 'dashboard',
          element: <Overview />,
        },
        {
          // 个人账号信息页：任何登录用户都能打开，不需要 settings 权限。
          path: 'account',
          element: <AccountPage />,
        },
        {
          // 关于页：产品定位、能力清单与版本信息，入口在头像菜单。
          path: 'about',
          element: <AboutPage />,
        },
        {
          path: 'settings',
          element: <SettingsRedirect />,
        },
        {
          // 兼容旧链接：/settings/users → /settings/user?tab=users
          path: 'settings/users',
          element: <ClusterNavigate to="/settings/user?tab=users" replace />,
        },
        {
          // 兼容旧链接：/settings/group → /settings/user?tab=group
          path: 'settings/group',
          element: <ClusterNavigate to="/settings/user?tab=group" replace />,
        },
        {
          // 兼容旧链接：/settings/binding-groups → /settings/rbac?rbacTab=binding-groups
          path: 'settings/binding-groups',
          element: (
            <ClusterNavigate
              to="/settings/rbac?rbacTab=binding-groups"
              replace
            />
          ),
        },
        {
          // 兼容旧链接：/settings/oauth → /settings/security?tab=authProviders
          path: 'settings/oauth',
          element: (
            <ClusterNavigate
              to="/settings/security?tab=authProviders"
              replace
            />
          ),
        },
        {
          path: 'settings/:section',
          element: <SettingsPage />,
        },
        {
          path: 'rbac',
          element: <RBACRedirect />,
        },
        {
          path: 'deployments/create',
          element: <DeploymentCreatePage />,
        },
        {
          path: 'deployments/:namespace/create',
          element: <DeploymentCreatePage />,
        },
        {
          path: 'deployments/:namespace/:name/edit',
          element: <DeploymentCreatePage />,
        },
        {
          path: 'deployments/:namespace/:name/clone',
          element: <DeploymentCreatePage clone />,
        },
        {
          path: 'deployments/:namespace',
          element: <DeploymentListPage />,
        },
        {
          path: 'services/create',
          element: <ServiceCreatePage />,
        },
        {
          path: 'services/:namespace/create',
          element: <ServiceCreatePage />,
        },
        {
          path: 'services/:namespace/:name/edit',
          element: <ServiceCreatePage />,
        },
        {
          path: 'services/:namespace/:name/clone',
          element: <ServiceCreatePage clone />,
        },
        {
          path: 'services/:namespace',
          element: <ServiceListPage />,
        },
        {
          path: 'cronjobs/create',
          element: <DeploymentCreatePage resourceType="cronjobs" />,
        },
        {
          path: 'cronjobs/:namespace/create',
          element: <DeploymentCreatePage resourceType="cronjobs" />,
        },
        {
          path: 'cronjobs/:namespace/:name/edit',
          element: <DeploymentCreatePage resourceType="cronjobs" />,
        },
        {
          path: 'cronjobs/:namespace/:name/clone',
          element: <DeploymentCreatePage resourceType="cronjobs" clone />,
        },
        {
          path: 'cronjobs/:namespace',
          element: <CronJobListPage />,
        },
        {
          path: 'jobs/create',
          element: <DeploymentCreatePage resourceType="jobs" />,
        },
        {
          path: 'jobs/:namespace/create',
          element: <DeploymentCreatePage resourceType="jobs" />,
        },
        {
          path: 'jobs/:namespace/:name/edit',
          element: <DeploymentCreatePage resourceType="jobs" />,
        },
        {
          path: 'jobs/:namespace/:name/clone',
          element: <DeploymentCreatePage resourceType="jobs" clone />,
        },
        {
          path: 'jobs/:namespace',
          element: <JobListPage />,
        },
        {
          path: 'pods/create',
          element: <DeploymentCreatePage resourceType="pods" />,
        },
        {
          path: 'pods/:namespace/create',
          element: <DeploymentCreatePage resourceType="pods" />,
        },
        {
          path: 'pods/:namespace/:name/edit',
          element: <DeploymentCreatePage resourceType="pods" />,
        },
        {
          path: 'pods/:namespace/:name/clone',
          element: <DeploymentCreatePage resourceType="pods" clone />,
        },
        {
          path: 'pods/:namespace',
          element: <PodListPage />,
        },
        {
          path: 'daemonsets/create',
          element: <DeploymentCreatePage resourceType="daemonsets" />,
        },
        {
          path: 'daemonsets/:namespace/create',
          element: <DeploymentCreatePage resourceType="daemonsets" />,
        },
        {
          path: 'daemonsets/:namespace/:name/edit',
          element: <DeploymentCreatePage resourceType="daemonsets" />,
        },
        {
          path: 'daemonsets/:namespace/:name/clone',
          element: <DeploymentCreatePage resourceType="daemonsets" clone />,
        },
        {
          path: 'daemonsets/:namespace',
          element: <DaemonSetListPage />,
        },
        {
          path: 'statefulsets/create',
          element: <DeploymentCreatePage resourceType="statefulsets" />,
        },
        {
          path: 'statefulsets/:namespace/create',
          element: <DeploymentCreatePage resourceType="statefulsets" />,
        },
        {
          path: 'statefulsets/:namespace/:name/edit',
          element: <DeploymentCreatePage resourceType="statefulsets" />,
        },
        {
          path: 'statefulsets/:namespace/:name/clone',
          element: <DeploymentCreatePage resourceType="statefulsets" clone />,
        },
        {
          path: 'statefulsets/:namespace',
          element: <StatefulSetListPage />,
        },
        {
          path: 'configmaps/create',
          element: <ConfigMapCreatePage />,
        },
        {
          path: 'configmaps/:namespace/create',
          element: <ConfigMapCreatePage />,
        },
        {
          // 编辑：同一套表单读出线上对象（列表/详情走通用路由 :resource/...）。
          path: 'configmaps/:namespace/:name/edit',
          element: <ConfigMapCreatePage />,
        },
        {
          path: 'configmaps/:namespace/:name/clone',
          element: <ConfigMapCreatePage clone />,
        },
        {
          path: 'secrets/create',
          element: <SecretCreatePage />,
        },
        {
          path: 'secrets/:namespace/create',
          element: <SecretCreatePage />,
        },
        {
          path: 'secrets/:namespace/:name/edit',
          element: <SecretCreatePage />,
        },
        {
          path: 'secrets/:namespace/:name/clone',
          element: <SecretCreatePage clone />,
        },
        {
          // 集群级存储资源：没有命名空间段。
          path: 'persistentvolumes/create',
          element: <PVCreatePage />,
        },
        {
          path: 'persistentvolumes/:name/edit',
          element: <PVCreatePage />,
        },
        {
          path: 'storageclasses/create',
          element: <StorageClassCreatePage />,
        },
        {
          path: 'storageclasses/:name/edit',
          element: <StorageClassCreatePage />,
        },
        {
          path: 'crds/:crd',
          element: <CRListPage />,
        },
        {
          path: 'charts',
          element: <HelmChartListPage />,
        },
        {
          path: 'charts/:repository/:name',
          element: <HelmChartDetailPage />,
        },
        {
          path: 'crds/:resource/:namespace/:name',
          element: <ResourceDetail />,
        },
        {
          path: 'crds/:resource/:name',
          element: <ResourceDetail />,
        },
        {
          path: ':resource/:name',
          element: <ResourceDetail />,
        },
        {
          path: ':resource',
          element: <ResourceList />,
        },
        {
          path: ':resource/:namespace/:name',
          element: <ResourceDetail />,
        },
      ],
    },
    {
      // 独立 AI 助手页：同样挂在集群前缀下（无集群段时走下面的兜底重定向）。
      path: '/_clusters/:clusterSlug/ai-chat-box',
      element: (
        <InitCheckRoute>
          <ProtectedRoute>
            <StandaloneAIChatApp />
          </ProtectedRoute>
        </InitCheckRoute>
      ),
    },
    {
      // 旧路径兜底：/、/deployments/...、/_clusters（不带 slug）→ 补集群段。
      // 放在所有具名路由之后，按「上次使用 → 默认集群」跳转。
      path: '*',
      element: (
        <InitCheckRoute>
          <ProtectedRoute>
            <LegacyClusterRedirect />
          </ProtectedRoute>
        </InitCheckRoute>
      ),
    },
  ],
  {
    basename: subPath,
  }
)
