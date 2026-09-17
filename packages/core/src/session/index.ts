/**
 * 会话层。
 *
 * 职责划分：
 * - store：磁盘读写，只认文件和事件，不含业务判断
 * - projector：把事件日志折叠成内存投影（纯状态变换，可重放）
 * - runtime：把两者组装起来，提供「加载会话、接纳输入、中断」这些操作
 */
export * from "./projector.js"
export * from "./runtime.js"
export * from "./store.js"
