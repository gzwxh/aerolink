import { defineConfig } from "vitepress";

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: "鸢联 AeroLink",
  description: "一个现代 Kubernetes 仪表盘",

  sitemap: {
    hostname: "https://kite.zzde.me",
    lastmodDateOnly: false,
  },

  markdown: {
    image: {
      lazyLoading: true,
    },
  },

  lastUpdated: true,

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
              ],
            },
            {
              text: "Configuration",
              items: [
                { text: "User Management", link: "/en/config/user-management" },
                { text: "OAuth Setup", link: "/en/config/oauth-setup" },
                { text: "RBAC Configuration", link: "/en/config/rbac-config" },
                { text: "Prometheus Setup", link: "/en/config/prometheus-setup" },
                { text: "Managed K8s Auth", link: "/en/config/managed-k8s-auth" },
                { text: "Environment Variables", link: "/en/config/env" },
                { text: "Configuration File", link: "/en/config/config-file" },
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
      },
    },
  },

  head: [
    ["link", { rel: "icon", href: "/logo.svg" }],
    [
      "script",
      {
        src: "https://cloud.umami.is/script.js",
        "data-website-id": "764af8e4-8fa4-4fc5-83e2-304718cc15fe",
        defer: "true",
      },
    ],
  ],

  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    logo: "/logo.svg",
    search: {
      provider: "local",
    },
    langMenuLabel: "Language",
    editLink: {
      pattern:
        "http://10.10.11.151:20216/teg/support-department/operation_rd_dept/aerolink/_edit/main/docs/:path",
      text: "在内部仓库中编辑此页面",
    },

    nav: [
      { text: "首页", link: "/" },
      { text: "指南", link: "/guide/" },
      { text: "配置", link: "/config/" },
      { text: "API", link: "/api/authentication" },
      { text: "常见问题", link: "/faq" },
    ],

    sidebar: {
      "/": [
        {
          text: "介绍",
          items: [
            { text: "什么是鸢联 AeroLink?", link: "/guide/" },
            { text: "开始", link: "/guide/installation" },
          ],
        },
        {
          text: "配置",
          items: [
            { text: "用户管理", link: "/config/user-management" },
            { text: "OAuth 设置", link: "/config/oauth-setup" },
            { text: "RBAC 配置", link: "/config/rbac-config" },
            { text: "Prometheus 设置", link: "/config/prometheus-setup" },
            { text: "托管 K8s 认证", link: "/config/managed-k8s-auth" },
            { text: "环境变量", link: "/config/env" },
            { text: "配置文件", link: "/config/config-file" },
            { text: "Chart Values", link: "/config/chart-values" },
          ],
        },
        {
          text: "使用指南",
          items: [
            { text: "全局搜索", link: "/guide/global-search" },
            { text: "相关资源", link: "/guide/related-resources" },
            { text: "日志", link: "/guide/logs" },
            { text: "监控", link: "/guide/monitoring" },
            { text: "Helm 管理", link: "/guide/helm-management" },
            { text: "AI 助手", link: "/guide/ai-assistant" },
            { text: "Web 终端", link: "/guide/web-terminal" },
            { text: "鸢联 AeroLink Cluster Agent", link: "/guide/aerolink-cluster-agent" },
            { text: "资源历史", link: "/guide/resource-history" },
            { text: "自定义侧边栏", link: "/guide/custom-sidebar" },
            { text: "Kube Proxy", link: "/guide/kube-proxy" },
          ],
        },
        {
          text: "常见问题",
          link: "/faq",
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

    socialLinks: [{ icon: "github", link: "https://github.com/kite-org/kite" }],

    footer: {
      message: "Released under the Apache License.",
      copyright: "Copyright © 2025-present Kite Contributors",
    },
  },
});
