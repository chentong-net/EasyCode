import type { Agent, PermissionRule } from "@easycode/schema"

import { createLogger } from "./log.js"

const logger = createLogger("agent")

/**
 * 内置 agent 定义。
 *
 * 首版只有一个 build agent。之所以不把系统提示词和权限直接写死在 runner 里，
 * 是因为「agent 是一个可配置对象」这个抽象决定了将来加只读 agent（plan/explore）
 * 是加一条定义，而不是改运行时逻辑。
 * 会话记录里已经存了 agent id，所以加定义不会破坏历史会话。
 */

/** 默认 agent。会话创建时使用。 */
export const DEFAULT_AGENT_ID = "build"

/**
 * build agent 的系统提示词。
 *
 * 它会被拼在 baseline（基线）系统上下文之前，属于请求的最前缀部分。写的时候注意两点：
 * 1. 不要包含任何会变化的信息（时间、随机值、目录）——目录等动态信息由
 *    baseline 系统上下文提供，混在这里会破坏「前缀逐字节稳定」这个前提。
 * 2. 强调「不做用户没要求的事」，这是 agent 最容易失控的地方。
 */
const BUILD_SYSTEM_PROMPT = `你是 EasyCode，一个运行在用户本地机器上的编程助手，可以通过工具读写文件、检索代码、执行命令。

工作方式：
- 动手改代码之前，先把相关代码读清楚。不要基于猜测修改文件。
- 任务有三个以上独立步骤时，先用 todowrite 建立完整计划，并在开始时和完成后及时更新状态。
- 局部修改一律使用 edit 做精确替换；只有创建新文件或整体重写时才使用 write。
- 改完代码后，尽量用项目自身的手段验证（类型检查、测试、构建）。如果确实没有可用的验证方式，要如实说明「未验证」，不要假设改动一定正确。
- 需要用户做决定时，使用 question 工具提问，不要自行假设用户的意图。
- 修改之后如果尚未验证，不要直接宣称任务完成；验证失败时先诊断并修复，或者明确说明阻塞和剩余工作。
- 只有目标和验收条件真正满足时才宣告完成。部分完成、阻塞和取消都要如实说明。
- 完成任务后，用简洁的中文说明做了什么、涉及哪些文件。

行为准则：
- 只做用户要求的事。不要顺手重构、不要添加没有被要求的功能、不要过度设计。
- 除非用户明确要求，不要创建文档类文件。
- 遇到无法解决的问题（缺少依赖、权限不足、命令失败）时如实说明，不要伪造执行结果。
- 工具返回的错误信息要如实反映，不要编造「命令执行成功」。`

/**
 * 内置 agent 列表。
 *
 * 权限规则按顺序求值，取最后一条同时匹配 action 与 resource 的规则，
 * 因此「放宽」的规则写在前面、「收紧」的规则写在后面。
 */
const BUILTIN_AGENTS: Agent[] = [
  {
    id: DEFAULT_AGENT_ID,
    description: "默认的编码助手，可以读写文件并执行命令",
    system: BUILD_SYSTEM_PROMPT,
    // 30 个 provider turn（模型调用轮次）足够完成绝大多数编码任务；达到上限后会禁用工具强制收尾，
    // 避免模型陷入「反复读同一个文件」的死循环
    steps: 30,
    permissions: [
      // 兜底：默认允许
      { action: "*", resource: "*", effect: "allow" },
      // 结构化文件工具访问工作目录之外的路径时需要用户确认；
      // bash 等工具不会把命令中的路径转换成该 action
      { action: "external_directory", resource: "*", effect: "ask" },
      // read 动作读取环境变量文件时需要用户确认；grep 与 bash 不受这条 action 保护
      { action: "read", resource: "*.env", effect: "ask" },
      { action: "read", resource: "*.env.*", effect: "ask" },
      // 破坏性命令需要确认
      { action: "bash", resource: "*rm -rf*", effect: "ask" },
      { action: "bash", resource: "*sudo *", effect: "ask" },
    ] satisfies PermissionRule[],
  },
]

export interface AgentRegistry {
  /** 按 id 取 agent，不存在时返回 undefined */
  get(id: string): Agent | undefined
  /** 取默认 agent */
  default(): Agent
  /** 全部 agent，用于 UI 展示 */
  all(): Agent[]
}

export const createAgentRegistry = (): AgentRegistry => {
  const agents = new Map(BUILTIN_AGENTS.map((agent) => [agent.id, agent]))

  const get = (id: string): Agent | undefined => agents.get(id)

  const fallback = (): Agent => {
    const agent = agents.get(DEFAULT_AGENT_ID)
    // 默认 agent 是硬编码的存在，缺失说明代码被改坏了，直接抛错比静默降级更好
    if (!agent) throw new Error(`内置 agent 缺失：${DEFAULT_AGENT_ID}`)
    return agent
  }

  return {
    get,
    default: fallback,
    all: () => [...agents.values()],
  }
}

/** 按 id 解析 agent，找不到时回退到默认 agent 并记录警告。 */
export const resolveAgent = (registry: AgentRegistry, id: string): Agent => {
  const agent = registry.get(id)
  if (agent) return agent
  logger.warn("会话引用了不存在的 agent，已回退到默认 agent", { agentID: id })
  return registry.default()
}
