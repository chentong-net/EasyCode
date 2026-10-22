/**
 * LLM 协议层的统一出口。
 *
 * 这一层只做「一次 provider turn（模型调用轮次）」：报文构造、流式解码、错误归一。
 * 它不知道会话、工具执行和权限的存在，因此可以被独立替换成别的协议实现。
 */
export * from "./client.js"
export * from "./error.js"
export * from "./protocol.js"
export * from "./stream.js"
export * from "./types.js"
