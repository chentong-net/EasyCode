import { z } from "zod"

import { PermissionRule } from "./permission.js"

/**
 * 一个 agent 的完整定义。
 *
 * 首版只有一个内置 agent（build）。保留这个结构而不是硬编码成常量，
 * 是因为将来加 plan / explore 这类只读 agent 时只需要多一条定义，
 * 不需要改运行时逻辑。
 */
export const Agent = z.object({
  /** agent 标识，用于解析会话绑定的 agent */
  id: z.string(),
  /** 一句话描述，展示在 UI 上 */
  description: z.string(),
  /** 系统提示词。它会被拼在 baseline（基线）之前，属于请求的最前缀部分 */
  system: z.string(),
  /**
   * 可选的 provider turn（模型调用轮次）安全上限。
   * 不设置时不会因为固定步数结束；达到上限后仍会禁用工具并强制收尾。
   */
  steps: z.number().int().positive().optional(),
  /**
   * 每隔多少个 provider turn 向用户确认是否继续。
   * 这是续行检查点，不是任务终止条件。
   */
  checkpointSteps: z.number().int().positive().optional(),
  /** 该 agent 的权限规则集，按顺序求值，最后一条匹配的规则生效 */
  permissions: z.array(PermissionRule),
})

export type Agent = z.infer<typeof Agent>
