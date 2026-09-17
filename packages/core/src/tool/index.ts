/**
 * 工具系统。
 *
 * - tool：工具的定义契约与 JSON Schema 生成
 * - registry：统一的入参校验、授权、输出截断
 * - output：输出裁剪与落盘
 * - paths：路径解析与工作目录边界检查
 * - builtin：七个内置工具的实现
 */
export * from "./builtin/index.js"
export * from "./output.js"
export * from "./paths.js"
export * from "./registry.js"
export * from "./tool.js"
