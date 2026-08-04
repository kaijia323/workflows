import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
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
  {
    rules: {
      // 约定:_ 前缀参数表示"故意未使用"(如 express 的 _req)
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
)
