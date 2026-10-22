import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * 渲染层的构建配置。
 *
 * 只有渲染层走 Vite：主进程、预加载脚本与 sidecar 都是纯 Node 代码，
 * 用 esbuild 直接打成单个 CJS 文件更简单——不需要 dev server、
 * 不需要热更新，也不需要在打包时处理 node_modules 的软链问题。
 *
 * `base: "./"` 让构建产物中的资源引用保持相对路径，便于通过自定义
 * `app://easycode` 协议加载，而不依赖固定的站点根路径。
 */
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
  },
})
