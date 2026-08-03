import js from '@eslint/js'
import globals from 'globals'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    // monorepo:固定 tsconfig 查找根,避免 lint-staged 从仓库根运行时报错
    languageOptions: {
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    // 浏览器运行环境:fetch / console 等全局
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.es2022 },
    },
  },
  {
    // .vue 文件:script 块交给 tseslint.parser 解析 TS
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser },
    },
  },
  {
    rules: {
      // 骨架阶段单文件组件(如 App.vue)允许单单词命名
      'vue/multi-word-component-names': 'off',
      // v-html 仅在 MessageBubble 受控入口使用,renderMarkdown 已统一转义原生 HTML + 链接协议白名单
      'vue/no-v-html': 'off',
    },
  },
)
