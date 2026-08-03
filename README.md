# dag-pi

Turborepo monorepo — DAG 可视化与流水线管理平台(骨架)。

## 技术栈

| 包 | 技术 |
| --- | --- |
| `apps/web` | Vue 3 + TypeScript + Vite + Tailwind CSS v4 |
| `apps/api` | H3(Web 标准 HTTP 框架)+ TypeScript |
| `packages/shared` | 跨端共享类型 |

## 端口策略(对外只暴露一个入口)

前后端同源部署,**用户只访问一个地址**:

| 环境 | 对外端口 | 说明 |
| --- | --- | --- |
| 开发 | **15200** | Vite dev server 托管页面,`/api` 自动代理到后端 3000(内部端口,不对外) |
| 生产 | **5200** | Express 托管前端构建产物 + API,单端口同源(可 `PORT` 覆盖) |

## 命令

```bash
pnpm install     # 安装依赖
pnpm dev         # 开发:web(15200)+ api(3000),http://localhost:15200
pnpm build       # 构建所有包(shared → api/web)
pnpm start       # 生产启动:仅启动已构建的 API(5200,托管前端)
pnpm preview     # 打包前后端 → 自动执行 start(生产模式,5200)
pnpm typecheck   # 类型检查
```

## 目录结构

```
dag-pi/
├── apps/
│   ├── api/          # H3 API 服务(生产时托管 web/dist)
│   └── web/          # Vue 3 前端(dev 15200 / 构建产物 dist)
├── packages/
│   └── shared/       # 共享类型(构建产物供 api/web 消费)
└── turbo.json
```
