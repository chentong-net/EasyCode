/**
 * 各类实体的标识符类型定义。
 *
 * 这里只用类型别名而不是 branded type，原因是品牌类型会在 zod 推断、
 * HTTP 序列化、跨包传递时引入大量类型断言，收益不足以抵消噪音。
 * 各 ID 的生成逻辑位于 @easycode/core，并遵循 `前缀_随机串` 的约定，
 * 便于在日志和调试时一眼看出这是什么 ID。
 */

/** 会话语义标识，形如 `ses_ab12cd...` */
export type SessionID = string

/** 消息标识，形如 `msg_ab12cd...` */
export type MessageID = string

/** 用户输入标识，形如 `in_ab12cd...` */
export type InputID = string

/** 工具调用标识，由模型给出，形如 `call_ab12cd...` */
export type ToolCallID = string

/** 权限审批请求标识，形如 `per_ab12cd...` */
export type PermissionRequestID = string
