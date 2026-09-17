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
  /** agent 标识，同时作为权限规则里的 agent 名 */
  id: z.string(),
  /** 一句话描述，展示在 UI 上 */
  description: z.string(),
  /** 系统提示词。它会被拼在 baseline 之前，属于请求的最前缀部分 */
  system: z.string(),
  /**
   * 单个回合内允许的最大 provider turn 数。
   * 达到上限后会禁用工具并追加一条收尾提示，强制模型给出最终答复。
   */
  steps: z.number().int().positive(),
  /** 该 agent 的权限规则集，按顺序求值，最后一条匹配的规则生效 */
  permissions: z.array(PermissionRule),
})

export type Agent = z.infer<typeof Agent>
