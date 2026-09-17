/**
 * @easycode/client
 *
 * 界面与 Core 之间唯一被允许的通信方式。
 *
 * 依赖方向上的硬约束：本包依赖 schema 与 protocol，**永不依赖 core 或 server**。
 * 因此渲染进程可以安全地打包它，而不会把整个 Agent 运行时拖进浏览器。
 * 一旦有人往这里加入 core 的 import，构建就会立刻失败——约束由构建系统保证，
 * 而不是靠约定。
 */
export * from "./client.js"
export * from "./http.js"
export * from "./sse.js"
