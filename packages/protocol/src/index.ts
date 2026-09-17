/**
 * @easycode/protocol
 *
 * HTTP 传输契约。它站在 schema 之上、server 与 client 之间：
 * - schema 定义「领域里有什么」（会话、消息、事件）
 * - 本包定义「这些东西怎么过网线」（端点、请求体、响应体、错误标签）
 *
 * 约束：本包必须保持「浏览器安全」。client 会被渲染进程打包，
 * 因此这里不得引入 node: 内置模块、HTTP 框架或任何与进程相关的 API。
 * 一旦违反，渲染进程的构建就会失败——这是刻意的，让违规立刻暴露。
 */
export * from "./dto.js"
export * from "./endpoints.js"
export * from "./error.js"
