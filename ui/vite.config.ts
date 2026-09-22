import { readFileSync, writeFileSync } from 'fs'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

import monacoEditorFeatures from './plugins/vite-plugin-monaco-editor.ts'
import { normalizeBasePath } from './src/lib/base-path.ts'

const devSubPath = normalizeBasePath(
  process.env.AEROLINK_BASE ?? process.env.KITE_BASE
)
// 产物 index.html 里的资源路径会写成这个占位符，由二进制在托管时替换成运行时基础路径
// （见 pkg/utils/utils.go），两边必须保持一致。
const runtimeBasePlaceholder = '__AEROLINK_BASE__'

function getDevBase() {
  return devSubPath ? `${devSubPath}/` : '/'
}

function getManualChunk(id: string) {
  const normalizedId = id.replaceAll('\\', '/')

  if (
    normalizedId.includes('/src/lib/monaco-runtime.ts') ||
    normalizedId.includes('/node_modules/@monaco-editor/') ||
    normalizedId.includes('/node_modules/monaco-editor/')
  ) {
    return 'monaco'
  }

  if (
    normalizedId.includes('/src/components/terminal-content.tsx') ||
    normalizedId.includes('/node_modules/@xterm/')
  ) {
    return 'terminal'
  }

  if (
    normalizedId.includes('/src/components/log-viewer-content.tsx') ||
    normalizedId.includes('/src/lib/ansi-parser.ts')
  ) {
    return 'log-viewer'
  }

  if (
    normalizedId.includes('/node_modules/recharts/') ||
    normalizedId.includes('/node_modules/victory-vendor/')
  ) {
    return 'recharts'
  }

  return undefined
}

function runtimeBaseHtmlPlugin(): Plugin {
  let buildOutDir = ''

  return {
    name: 'kite-runtime-base-html',
    apply: 'build',
    configResolved(config) {
      buildOutDir = path.resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const indexHtmlPath = path.join(buildOutDir, 'index.html')
      const html = readFileSync(indexHtmlPath, 'utf8')

      // Make the first HTML-loaded assets runtime-base aware without relying on <base href>.
      const nextHtml = html.replaceAll(
        /((?:href|src)=["'])\.\/assets\//g,
        `$1${runtimeBasePlaceholder}/assets/`
      )

      if (nextHtml !== html) {
        writeFileSync(indexHtmlPath, nextHtml)
      }
    },
  }
}

export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : getDevBase(),
  plugins: [
    react(),
    tailwindcss(),
    monacoEditorFeatures({
      features: [
        'bracketMatching',
        'clipboard',
        'comment',
        'cursorUndo',
        'find',
        'folding',
        'indentation',
        'lineSelection',
        'linesOperations',
        'readOnlyMessage',
        'tokenization',
        'toggleTabFocusMode',
        'wordOperations',
      ],
    }),
    runtimeBaseHtmlPlugin(),
  ],
  envPrefix: ['VITE_', 'AEROLINK_', 'KITE_'],
  build: {
    outDir: '../static',
    emptyOutDir: true,
    chunkSizeWarningLimit: 3000,
    modulePreload: true,
    /*
      前端浏览器基线：Chrome / Edge 111、Firefox 128、Safari / iOS 16.4。

      显式写死，不跟 Vite 默认的 'baseline-widely-available'
      （chrome111 / edge111 / firefox114 / safari16.4）走：真实下限由产物里的 CSS 决定，
      而 Firefox 的 128 才是下限——产物里的 @property（Tailwind 的 --tw-* 注册属性）
      要 128，:has()（sidebar 折叠宽度、card 的 inset 网格、表格首列）要 121。
      Vite 默认声明的 firefox114 是低估，会让人误以为 114 也能用。

      低于这条基线的浏览器不做兼容（规则见 AGENTS.md「界面（UI）」），
      改动原因见 docs/dev/plans/2026-09-21-theme-contrast-and-browser-baseline.md。
    */
    target: ['chrome111', 'edge111', 'firefox128', 'safari16.4', 'ios16.4'],
    rolldownOptions: {
      output: {
        manualChunks: getManualChunk,
      },
    },
  },
  server: {
    watch: {
      ignored: ['**/.vscode/**'],
    },
    proxy: {
      [devSubPath + '/api/']: {
        changeOrigin: true,
        target: 'http://localhost:8080',
      },
      '^/ws/.*': {
        target: 'ws://localhost:8080',
        ws: true,
        rewriteWsOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  worker: {
    format: 'es',
  },
  define: {
    global: 'globalThis',
  },
}))
