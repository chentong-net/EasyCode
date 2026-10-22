import { z } from "zod"

/**
 * 权限规则的裁决结果（effect）。
 *
 * - `allow`：直接执行
 * - `ask`：挂起并请求用户审批
 * - `deny`：拒绝执行并停止当前回合
 */
export const PermissionEffect = z.enum(["allow", "ask", "deny"])

export type PermissionEffect = z.infer<typeof PermissionEffect>

/**
 * 一条权限规则。
 *
 * `action` 与 `resource` 都支持通配符（`*` 匹配任意字符、`?` 匹配单个字符），
 * 求值时取「最后一条同时匹配 action 和 resource 的规则」，
 * 因此规则集的顺序有意义：越靠后优先级越高。
 *
 * action 的取值由工具自行声明，内置约定：
 * `read` / `write` / `edit` / `bash` / `grep` / `glob` / `todowrite` / `external_directory`。
 * 其中 `external_directory` 是一个特殊动作，用于「访问工作目录之外的路径」这类二次确认。
 */
export const PermissionRule = z.object({
  action: z.string(),
  resource: z.string(),
  effect: PermissionEffect,
})

export type PermissionRule = z.infer<typeof PermissionRule>

/** 用户对审批请求的回应。 */
export const PermissionReply = z.enum([
  /** 仅本次允许 */
  "once",
  /** 本次允许，并记住这条规则（需要请求携带 save 模式） */
  "always",
  /** 拒绝 */
  "reject",
])

export type PermissionReply = z.infer<typeof PermissionReply>

/**
 * 一个待审批的权限请求。
 *
 * 请求会被持久化到事件日志，原因是：如果 UI 崩溃重连、或进程重启，
 * 内存里等待审批的工具调用就消失了，此时必须能识别出「这条请求已经作废」，
 * 否则界面会永远显示一个转圈的审批卡片。
 */
export const PermissionRequest = z.object({
  id: z.string(),
  sessionID: z.string(),
  /** 发起请求的工具调用 ID，用于把审批结果和工具调用关联起来 */
  callID: z.string(),
  action: z.string(),
  /** 需要授权的资源列表，例如 bash 的完整命令、read 的文件路径 */
  resources: z.array(z.string()),
  /**
   * 当用户选择「总是允许」时需要持久化的模式。
   * 为空表示该请求不支持记住（例如外部目录访问这类一次性确认）。
   */
  save: z.array(z.string()),
  createdAt: z.number(),
})

export type PermissionRequest = z.infer<typeof PermissionRequest>
