import { createBrowserRouter, Navigate } from 'react-router-dom'

import App, { StandaloneAIChatApp } from './App'
import { InitCheckRoute } from './components/init-check-route'
import { ProtectedRoute } from './components/protected-route'
import { getSubPath } from './lib/subpath'
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
      path: '/ai-chat-box',
      element: (
        <InitCheckRoute>
          <ProtectedRoute>
            <StandaloneAIChatApp />
          </ProtectedRoute>
        </InitCheckRoute>
      ),
    },
    {
      path: '/',
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
          path: 'settings',
          element: <SettingsRedirect />,
        },
        {
          // 兼容旧链接：/settings/users → /settings/user?tab=users
          path: 'settings/users',
          element: <Navigate to="/settings/user?tab=users" replace />,
        },
        {
          // 兼容旧链接：/settings/group → /settings/user?tab=group
          path: 'settings/group',
          element: <Navigate to="/settings/user?tab=group" replace />,
        },
        {
          // 兼容旧链接：/settings/binding-groups → /settings/rbac?rbacTab=binding-groups
          path: 'settings/binding-groups',
          element: (
            <Navigate to="/settings/rbac?rbacTab=binding-groups" replace />
          ),
        },
        {
          // 兼容旧链接：/settings/oauth → /settings/security?tab=authProviders
          path: 'settings/oauth',
          element: (
            <Navigate to="/settings/security?tab=authProviders" replace />
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
          // 集群级存储资源：没有命名空间段。
          path: 'persistentvolumes/create',
          element: <PVCreatePage />,
        },
        {
          path: 'storageclasses/create',
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
  ],
  {
    basename: subPath,
  }
)
