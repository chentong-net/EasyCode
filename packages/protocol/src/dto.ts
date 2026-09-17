import { z } from "zod"

import { Delivery, Message, PermissionReply, PermissionRequest, Session } from "@easycode/schema"

/**
 * HTTP 报文的数据结构。
 *
 * 这里刻意不直接复用领域语义类型作为请求体，而是单独定义请求/响应外壳：
 * 语义类型回答「一个会话是什么」，报文类型回答「创建会话要传什么字段」。
 * 二者恰好长得像不代表它们应该合并——把领域对象的字段直接暴露成请求体，
 * 将来给领域对象加字段就会静默地把接口也改了。
 */

/** 健康检查响应。桌面端主进程轮询它来判断 sidecar 是否已经可服务。 */
export const HealthResponse = z.object({
  ok: z.literal(true),
  /** 运行时版本，取自 package.json */
  version: z.string(),
  /** 当前固定使用的模型 id，用于界面展示 */
  model: z.string(),
})

export type HealthResponse = z.infer<typeof HealthResponse>

/**
 * Agent 的对外描述。
 *
 * 只暴露 id 与描述：系统提示词和权限规则属于运行时内部信息，
 * 发给界面既没有用处，也会白白扩大接口表面积。
 */
export const AgentInfo = z.object({
  id: z.string(),
  description: z.string(),
})

export type AgentInfo = z.infer<typeof AgentInfo>

export const AgentListResponse = z.array(AgentInfo)

export type AgentListResponse = z.infer<typeof AgentListResponse>

/** 会话列表与详情。直接复用语义类型，因为它就是界面要展示的东西。 */
export const SessionListResponse = z.array(Session)

export type SessionListResponse = z.infer<typeof SessionListResponse>

export const SessionResponse = Session

export type SessionResponse = z.infer<typeof SessionResponse>

export const MessageListResponse = z.array(Message)

export type MessageListResponse = z.infer<typeof MessageListResponse>

/** 创建会话：必须先绑定工作目录，会话创建后目录不再改变。 */
export const CreateSessionRequest = z.object({
  /** 工作目录绝对路径。以 `~` 开头时由 Core 展开为用户主目录。 */
  directory: z.string().min(1, "工作目录不能为空"),
  title: z.string().optional(),
})

export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>

/** 提交用户输入。 */
export const PromptRequest = z.object({
  text: z.string().min(1, "输入内容不能为空"),
  /**
   * 投递方式。缺省为 `steer`（插话）：用户在回合运行中输入的内容
   * 默认应当在下一个安全边界立刻生效，而不是等整轮跑完。
   */
  delivery: Delivery.optional(),
})

export type PromptRequest = z.infer<typeof PromptRequest>

/**
 * 提交输入的响应。
 *
 * 只返回 inputID 而不等回合结束：真正的执行进度通过事件流反馈。
 * 让这个接口同步返回会让前端一直挂着一个可能长达数分钟的请求。
 */
export const PromptResponse = z.object({
  inputID: z.string(),
})

export type PromptResponse = z.infer<typeof PromptResponse>

/** 通用成功响应，用于中断这类没有返回内容的操作。 */
export const OkResponse = z.object({
  ok: z.literal(true),
})

export type OkResponse = z.infer<typeof OkResponse>

/** 待审批请求列表。 */
export const PermissionListResponse = z.array(PermissionRequest)

export type PermissionListResponse = z.infer<typeof PermissionListResponse>

/** 回应权限请求。 */
export const PermissionReplyRequest = z.object({
  reply: PermissionReply,
  /** 拒绝时给出的原因，会作为工具错误返回给模型 */
  feedback: z.string().optional(),
})

export type PermissionReplyRequest = z.infer<typeof PermissionReplyRequest>
