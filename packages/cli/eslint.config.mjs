import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // src/api 是 prepare.mjs 生成的复制品(在 apps/api 中已 lint),忽略避免重复
  { ignores: ['dist/**', 'node_modules/**', 'src/api/**'] },
  js.configs.recommended,
  {
    // 构建脚本等 Node 环境文件:声明全局,避免 no-undef
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
      },
    },
  },
  ...tseslint.configs.recommended,
  {
    // monorepo:固定 tsconfig 查找根,避免 lint-staged 从仓库根运行时报错
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
)
