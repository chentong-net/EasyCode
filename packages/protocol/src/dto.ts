import { z } from "zod"

import { Delivery, Message, PermissionReply, PermissionRequest, Session, Workspace } from "@easycode/schema"

/**
 * HTTP 报文的数据结构。
 *
 * 这里刻意不直接复用领域语义类型作为请求体，而是单独定义请求/响应外壳：
 * 语义类型回答「一个会话是什么」，报文类型回答「创建会话要传什么字段」。
 * 二者恰好长得像不代表它们应该合并——把领域对象的字段直接暴露成请求体，
 * 将来给领域对象加字段就会静默地把接口也改了。
 */

/** 健康检查响应。渲染层用它读取模型与上下文预算，主进程通过就绪文件等待 sidecar。 */
export const HealthResponse = z.object({
  ok: z.literal(true),
  /** 协议契约版本，当前来自 protocol 包中的 API_VERSION 常量 */
  version: z.string(),
  /** 当前固定使用的模型 id，用于界面展示 */
  model: z.string(),
  /**
   * 模型的上下文窗口大小。
   *
   * 界面需要它才能把「当前上下文占用了多少」显示成有意义的比例，
   * 只有 token 数字的话用户无法判断还能不能继续对话。
   */
  contextWindow: z.number().int().positive(),
  /**
   * 单轮回复的输出预留。
   *
   * 界面目前用 `contextWindow - maxOutputTokens` 估算「可用额度」。
   * Runner 实际还会扣除 compaction（压缩）安全余量，因此界面额度会略偏乐观。
   */
  maxOutputTokens: z.number().int().positive(),
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

/** 工作区列表与详情。 */
export const WorkspaceListResponse = z.array(Workspace)

export type WorkspaceListResponse = z.infer<typeof WorkspaceListResponse>

export const WorkspaceResponse = Workspace

export type WorkspaceResponse = z.infer<typeof WorkspaceResponse>

/** 添加工作区。目录必须已经存在，由 Core 解析和校验。 */
export const CreateWorkspaceRequest = z.object({
  directory: z.string().trim().min(1, "工作区目录不能为空"),
})

export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequest>

/** 重命名工作区的显示名称，不修改磁盘目录。 */
export const RenameWorkspaceRequest = z.object({
  name: z.string().trim().min(1, "工作区名称不能为空"),
})

export type RenameWorkspaceRequest = z.infer<typeof RenameWorkspaceRequest>

/**
 * 新建会话的默认工作目录。
 *
 * 放在这里是因为它需要被所有界面共用：命令行、桌面端的新建会话表单
 * 都要用它作为输入框的默认值。真正的路径展开由 Core 在创建会话时完成，
 * 因此这里保留 `~` 写法，不在这里解析成绝对路径。
 */
export const DEFAULT_WORKSPACE_DIRECTORY = "~/easycode"

export const SessionResponse = Session

export type SessionResponse = z.infer<typeof SessionResponse>

export const PinSessionRequest = z.object({
  pinned: z.boolean(),
})

export type PinSessionRequest = z.infer<typeof PinSessionRequest>

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
