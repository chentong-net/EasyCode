import type { Content, Todo, ToolCall, ToolDefinition } from "@easycode/schema"

import { PermissionDeclinedError, ToolFailure } from "../errors.js"
import { createLogger, type Logger } from "../log.js"
import { boundContent } from "./output.js"
import { toModelDefinition, type Tool, type ToolContext } from "./tool.js"

/**
 * 工具注册中心。
 *
 * 它承担三件必须在所有工具上统一完成的事，任何一件漏掉都会出问题：
 *
 * 1. **入参校验**：模型给的 JSON 不可信，必须先过 schema。
 * 2. **授权**：在执行任何副作用之前完成权限检查。
 * 3. **输出截断**：任何进入历史的文本都必须经过截断与落盘。
 *
 * 工具实现本身只管「怎么做这件事」，不操心上面三件事。
 */

export interface ToolSettlement {
  name: string
  status: "success" | "error"
  /** 结构化结果，供 UI 使用 */
  output?: unknown
  /** 发给模型的内容块（已完成截断） */
  content?: Content[]
  /** 完整输出的落盘路径 */
  outputPaths?: string[]
  error?: string
}

export interface SettleInput {
  call: ToolCall
  /** 协议层解析入参 JSON 失败时的说明；存在则直接结算为失败，不执行工具 */
  parseError?: string
  sessionID: string
  /** 会话绑定的工作目录 */
  directory: string
  signal: AbortSignal
  /** 由 runner 提供的授权函数，内部已绑定会话与 agent */
  authorize: (input: { callID: string; action: string; resources: string[]; save: string[] }) => Promise<void>
  /** 会话级状态访问，透传给需要它的工具（目前只有 todowrite） */
  session: {
    todos: () => Todo[]
    setTodos: (todos: Todo[]) => Promise<void>
  }
}

export interface ToolRegistry {
  /** 转换为发给模型的工具定义 */
  definitions(): ToolDefinition[]
  has(name: string): boolean
  /** 执行一次工具调用并结算 */
  settle(input: SettleInput): Promise<ToolSettlement>
}

export interface ToolRegistryDeps {
  tools: Tool<unknown>[]
  /** 完整输出的落盘函数 */
  saveToolOutput: (content: string) => Promise<string>
  logger?: Logger
}

export const createToolRegistry = (deps: ToolRegistryDeps): ToolRegistry => {
  const logger = deps.logger ?? createLogger("tool")
  const tools = new Map(deps.tools.map((tool) => [tool.name, tool]))

  const definitions = (): ToolDefinition[] => deps.tools.map((tool) => toModelDefinition(tool))

  const settle = async (input: SettleInput): Promise<ToolSettlement> => {
    const name = input.call.name
    const tool = tools.get(name)

    if (!tool) {
      logger.warn("模型请求了不存在的工具", { name, sessionID: input.sessionID })
      return { name, status: "error", error: `不存在名为 ${name} 的工具` }
    }

    if (input.parseError) {
      logger.warn("工具入参不是合法 JSON", { name, parseError: input.parseError })
      return { name, status: "error", error: `工具入参解析失败：${input.parseError}` }
    }

    const parsed = tool.input.safeParse(input.call.input)
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(根)"}: ${issue.message}`)
        .join("；")
      logger.warn("工具入参校验失败", { name, detail, received: input.call.input })
      return { name, status: "error", error: `工具入参不合法：${detail}` }
    }

    const context: ToolContext = {
      sessionID: input.sessionID,
      directory: input.directory,
      callID: input.call.callID,
      signal: input.signal,
      authorize: async ({ action, resources, save }) => {
        await input.authorize({
          callID: input.call.callID,
          action,
          resources,
          save: save ?? tool.savePatterns(parsed.data),
        })
      },
      session: input.session,
      logger: logger.child(name),
    }

    try {
      const result = await tool.execute(parsed.data, context)
      const bounded = await boundContent(result.content, deps.saveToolOutput)

      logger.debug("工具执行成功", {
        name,
        callID: input.call.callID,
        contentCount: bounded.files.length,
        truncated: bounded.paths.length > 0,
      })

      return {
        name,
        status: "success",
        output: result.output,
        content: buildModelContent(bounded.text, bounded.files),
        outputPaths: bounded.paths,
      }
    } catch (error) {
      // 用户拒绝授权会让整个回合停止，必须原样向上抛，不能变成工具错误结果
      if (error instanceof PermissionDeclinedError) throw error

      if (error instanceof ToolFailure) {
        logger.info("工具执行失败", { name, callID: input.call.callID, message: error.message })
        return { name, status: "error", error: error.message }
      }

      // 未预期的异常：记完整堆栈，但只把简短说明交给模型
      const message = error instanceof Error ? error.message : String(error)
      logger.error("工具执行抛出未预期的错误", { name, callID: input.call.callID, error })
      return { name, status: "error", error: `工具执行失败：${message}` }
    }
  }

  return { definitions, has: (name) => tools.has(name), settle }
}

/**
 * 组装发给模型的内容块。
 *
 * 文本为空时补一句说明：完全空的内容会让部分实现报错，
 * 而且模型会困惑「工具到底有没有执行」。
 */
const buildModelContent = (text: string, files: Content[]): Content[] => {
  if (text.length === 0 && files.length === 0) return [{ type: "text", text: "（工具执行完成，没有输出）" }]
  if (text.length === 0) return files
  return [{ type: "text", text }, ...files]
}
