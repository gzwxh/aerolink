import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // 集群信息进入浏览器地址栏（docs/dev/plans/2026-10-15-集群信息进入浏览器地址栏.md）：
      // 导航原语一律走集群包装版（ClusterLink/ClusterNavigate/useClusterNavigate/
      // useClusterLocation），保证 `/_clusters/<slug>` 前缀统一补齐。
      // 只有两个包装层文件可以碰原始 API；login 重定向、历史栈等确需原始语义的
      // 场景用 cluster-path 的 useRawNavigate / useRawLocation。
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react-router-dom',
              importNames: [
                'Link',
                'NavLink',
                'Navigate',
                'useNavigate',
                'useLocation',
              ],
              message:
                '请改用 @/components/cluster-link 的 ClusterLink/ClusterNavigate 与 @/lib/cluster-path 的 useClusterNavigate/useClusterLocation（见该文件的说明）。',
            },
          ],
        },
      ],
    },
  },
  {
    // 集群前缀的两个包装层文件本身必须操作原始路由 API。
    files: ['src/lib/cluster-path.ts', 'src/components/cluster-link.tsx'],
    rules: {
      'no-restricted-imports': 'off',
    },
  }
)
