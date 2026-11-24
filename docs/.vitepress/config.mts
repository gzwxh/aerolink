import { defineConfig } from "vitepress";

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "鸢联 AeroLink",
  description: "一个现代 Kubernetes 仪表盘",

  sitemap: {
    // 站点按公司内部域名部署，不再指向上游地址；换域名时同步这一行。
    hostname: "https://aerolink-docs.gcongo.cn",
    lastmodDateOnly: false,
  },

  markdown: {
    image: {
      lazyLoading: true,
    },
  },

  // 最后更新时间取自 git 历史。容器内构建（docs/Dockerfile）没有 .git 也没有 git 可执行文件，
  // 而 VitePress 在开启时会对每个页面 spawn git、失败即中断构建，所以那边用环境变量显式关掉。
  lastUpdated: !process.env.DOCS_SKIP_LAST_UPDATED,

  // 内部工程文档（功能索引、方案计划）不进入发布站点。
  srcExclude: ["dev/**"],
  locales: {
    root: {
      label: "中文",
      lang: "zh-CN",
      title: "鸢联 AeroLink",
      description: "一个现代 Kubernetes 仪表盘",
    },
    en: {
      label: "English",
      lang: "en",
      link: "/en/",
      title: "AeroLink",
      description: "A modern Kubernetes dashboard",
      themeConfig: {
        logo: { src: "/logo.svg", alt: "AeroLink" },
        nav: [
          { text: "Home", link: "/en/" },
          { text: "Guide", link: "/en/guide/" },
          { text: "Configuration", link: "/en/config/" },
          { text: "API", link: "/en/api/authentication" },
          { text: "FAQ", link: "/en/faq" },
        ],
        sidebar: {
          "/en/": [
            {
              text: "Introduction",
              items: [
                { text: "What is AeroLink?", link: "/en/guide/" },
                { text: "Getting Started", link: "/en/guide/installation" },
                { text: "Build and Push Image", link: "/en/guide/build-and-push-image" },
                { text: "Deployment and Operations", link: "/en/guide/operations" },
              ],
            },
            {
              text: "Configuration",
              items: [
                { text: "User Management", link: "/en/config/user-management" },
                { text: "OAuth Setup", link: "/en/config/oauth-setup" },
                { text: "RBAC Configuration", link: "/en/config/rbac-config" },
                { text: "Security Policy", link: "/en/config/security-policy" },
                { text: "Prometheus Setup", link: "/en/config/prometheus-setup" },
                { text: "Managed K8s Auth", link: "/en/config/managed-k8s-auth" },
                { text: "Environment Variables", link: "/en/config/env" },
                { text: "Configuration File", link: "/en/config/config-file" },
                { text: "Database Preparation", link: "/en/config/database" },
                { text: "Chart Values", link: "/en/config/chart-values" },
              ],
            },
            {
              text: "Usage",
              items: [
                { text: "Global Search", link: "/en/guide/global-search" },
                { text: "Related Resources", link: "/en/guide/related-resources" },
                { text: "Logs", link: "/en/guide/logs" },
                { text: "Monitor", link: "/en/guide/monitoring" },
                { text: "Helm Management", link: "/en/guide/helm-management" },
                { text: "AI Assistant", link: "/en/guide/ai-assistant" },
                { text: "Web Terminal", link: "/en/guide/web-terminal" },
                { text: "AeroLink Cluster Agent", link: "/en/guide/aerolink-cluster-agent" },
                { text: "Resource History", link: "/en/guide/resource-history" },
                { text: "Audit & Compliance", link: "/en/guide/audit-and-compliance" },
                { text: "Notifications & Announcements", link: "/en/guide/notification-and-announcements" },
                { text: "Custom Sidebar", link: "/en/guide/custom-sidebar" },
                { text: "Kube Proxy", link: "/en/guide/kube-proxy" },
              ],
            },
            {
              text: "FAQ",
              link: "/en/faq",
            },
          ],
          "/en/api/": [
            {
              text: "Authentication",
              link: "/en/api/authentication",
            },
            {
              text: "Resources",
              link: "/en/api/resources",
            },
            {
              text: "Cluster Management",
              link: "/en/api/cluster-management",
            },
            {
              text: "RBAC Management",
              link: "/en/api/rbac-management",
            },
            {
              text: "User Management",
              link: "/en/api/user-management",
            },
          ],
        },
        editLink: {
          pattern:
            "http://10.10.11.151:20216/teg/support-department/operation_rd_dept/aerolink/_edit/main/docs/:path",
          text: "Edit this page in the internal repository",
        },
        footer: {
          message: "Released under the Apache License.",
          copyright: "Copyright © 2025-present AeroLink",
        },
      },
    },
  },

  // 站点部署在内网/自建环境，不引入任何外部脚本（上游的 umami 统计已移除）。
  head: [["link", { rel: "icon", href: "/logo.svg" }]],

  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    logo: { src: "/logo.svg", alt: "鸢联 AeroLink" },
    search: {
      provider: "local",
    },
    langMenuLabel: "Language",
    editLink: {
      pattern:
        "http://10.10.11.151:20216/teg/support-department/operation_rd_dept/aerolink/_edit/main/docs/:path",
      text: "在内部仓库中编辑此页面",
    },

    // 帮助文档分五个区。常见问题是使用中最高频的入口，放一级；
    // 接口与产品介绍偏查阅，收进「参考」下拉，避免顶栏继续变长。
    nav: [
      { text: "安装部署", link: "/" },
      { text: "使用指南", link: "/usage/" },
      { text: "功能详解", link: "/features/" },
      { text: "管理配置", link: "/config/" },
      { text: "常见问题", link: "/faq" },
      {
        text: "参考",
        items: [
          { text: "API 参考", link: "/api/authentication" },
          { text: "关于鸢联 AeroLink", link: "/about" },
        ],
      },
    ],

    // 侧边栏按「栏目」拆开：VitePress 取最长匹配的路径前缀，
    // 所以每个栏目只放自己这一组，页面之间不再互相串。
    sidebar: {
      // 安装部署：认识产品 + 装起来、跑起来。首页就是这一栏的入口，
      // 所以键写成 "/"（前缀匹配同时覆盖 / 与 /guide/ 下的其余页面）。
      // 只放本栏页面；「使用指南」「常见问题」是别的区，不在这里重复出现。
      "/": [
        {
          text: "安装部署",
          items: [
            { text: "什么是鸢联 AeroLink?", link: "/" },
            { text: "快速部署", link: "/guide/quick-deploy" },
            { text: "安装指南", link: "/guide/installation" },
            { text: "构建并推送镜像", link: "/guide/build-and-push-image" },
            { text: "部署与运维", link: "/guide/operations" },
          ],
        },
      ],
      // 功能详解：一个功能一页。按 features/index 里已经写好的三类场景分组，
      // 而不是把 13 个页面平铺成一条长列表。
      "/features/": [
        { text: "总览：有哪些功能", link: "/features/" },
        {
          text: "观察与排障",
          items: [
            { text: "全局搜索", link: "/features/global-search" },
            { text: "相关资源", link: "/features/related-resources" },
            { text: "日志", link: "/features/logs" },
            { text: "监控", link: "/features/monitoring" },
            { text: "资源历史", link: "/features/resource-history" },
            { text: "AI 助手", link: "/features/ai-assistant" },
          ],
        },
        {
          text: "运维操作",
          items: [
            { text: "Helm 管理", link: "/features/helm-management" },
            { text: "Web 终端", link: "/features/web-terminal" },
            { text: "Kube Proxy", link: "/features/kube-proxy" },
            { text: "自定义侧边栏", link: "/features/custom-sidebar" },
          ],
        },
        {
          text: "治理与接入",
          items: [
            { text: "审计与合规", link: "/features/audit-and-compliance" },
            { text: "通知与公告", link: "/features/notification-and-announcements" },
            { text: "鸢联 AeroLink Cluster Agent", link: "/features/aerolink-cluster-agent" },
          ],
        },
      ],
      // 使用指南独立成栏：只给普通使用者看流程，不带介绍与配置。
      "/usage/": [
        {
          text: "使用指南",
          items: [
            { text: "总览：15 分钟上手", link: "/usage/" },
            { text: "第 1 步：登录与账号", link: "/usage/login" },
            { text: "第 2 步：认识界面", link: "/usage/interface" },
            { text: "第 3 步：找到并查看资源", link: "/usage/resources" },
            { text: "第 4 步：日志与容器终端", link: "/usage/logs-terminal" },
            { text: "第 5 步：创建与常用操作", link: "/usage/common-operations" },
            { text: "第 6 步：权限不够怎么办", link: "/usage/permissions" },
          ],
        },
        {
          text: "按资源类型创建与修改",
          items: [
            { text: "总览与选型", link: "/usage/create/" },
            { text: "Deployment", link: "/usage/create/deployment" },
            { text: "StatefulSet", link: "/usage/create/statefulset" },
            { text: "DaemonSet", link: "/usage/create/daemonset" },
            { text: "Job", link: "/usage/create/job" },
            { text: "CronJob", link: "/usage/create/cronjob" },
            { text: "Pod", link: "/usage/create/pod" },
            { text: "Service", link: "/usage/create/service" },
            { text: "ConfigMap", link: "/usage/create/configmap" },
            { text: "Secret", link: "/usage/create/secret" },
          ],
        },
      ],
      // 管理配置：管理员视角，按「账号 → 权限 → 监控 → 部署参数」的问事顺序分组。
      "/config/": [
        { text: "配置概览", link: "/config/" },
        {
          text: "账号与认证",
          items: [
            { text: "用户管理", link: "/config/user-management" },
            { text: "OAuth 设置", link: "/config/oauth-setup" },
            { text: "托管 K8s 认证", link: "/config/managed-k8s-auth" },
          ],
        },
        {
          text: "权限与安全",
          items: [
            { text: "RBAC 配置", link: "/config/rbac-config" },
            { text: "安全策略", link: "/config/security-policy" },
          ],
        },
        {
          text: "监控接入",
          items: [
            { text: "Prometheus 设置", link: "/config/prometheus-setup" },
          ],
        },
        {
          text: "部署参数",
          items: [
            { text: "环境变量", link: "/config/env" },
            { text: "配置文件", link: "/config/config-file" },
            { text: "数据库准备", link: "/config/database" },
            { text: "Chart Values", link: "/config/chart-values" },
          ],
        },
      ],
      "/api/": [
        {
          text: "认证",
          link: "/api/authentication",
        },
        {
          text: "资源操作",
          link: "/api/resources",
        },
        {
          text: "集群管理",
          link: "/api/cluster-management",
        },
        {
          text: "RBAC 管理",
          link: "/api/rbac-management",
        },
        {
          text: "用户管理",
          link: "/api/user-management",
        },
      ],
    },

    footer: {
      message: "Released under the Apache License.",
      copyright: "Copyright © 2025-present 鸢联 AeroLink",
    },
  },
});
