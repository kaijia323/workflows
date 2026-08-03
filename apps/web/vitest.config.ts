import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// 统一 NODE_ENV=test:外部 shell 可能残留 production(如先跑过 pnpm start/preview),
// vite-node 会在模块转换期把 process.env.NODE_ENV 编译进 Vue 源码;
// production 下 Vue 编译掉 devtools 事件,VTU 的 emitted() 捕获不到声明过的 emits。
// 在配置加载时(早于任何模块转换)修正,运行时与转换期保持一致。
process.env.NODE_ENV = 'test'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
  },
})
