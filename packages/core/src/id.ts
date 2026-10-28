import { randomBytes } from "node:crypto"

/**
 * 标识符生成。
 *
 * 统一使用 `前缀_随机串` 的形式，好处是翻日志时一眼就能看出某个字符串是什么 ID，
 * 不需要回头查代码。随机串用 hex 而不是 base64，避免出现 `-` `_` 之外需要转义的字符。
 */

const randomSegment = (bytes: number): string => randomBytes(bytes).toString("hex")

/** 生成带前缀的标识符。 */
export const createID = (prefix: string): string => `${prefix}_${randomSegment(12)}`

/** 会话 ID */
export const newSessionID = (): string => createID("ses")

/** 工作区 ID */
export const newWorkspaceID = (): string => createID("ws")

/** 消息 ID */
export const newMessageID = (): string => createID("msg")

/** 用户输入 ID */
export const newInputID = (): string => createID("in")

/** 权限审批请求 ID */
export const newPermissionRequestID = (): string => createID("per")

/**
 * 工具调用 ID 的兜底生成。
 *
 * 正常情况下 callID 由模型返回（形如 `call_abc123`），但部分兼容实现会省略它，
 * 这时用本地生成的值补上，保证「工具调用与结果必须能配对」这个前提始终成立。
 */
export const newToolCallID = (): string => createID("call")
