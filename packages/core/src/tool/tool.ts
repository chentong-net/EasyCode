import type { Content, Todo, ToolDefinition, ToolEffect, ToolMetadata } from "@easycode/schema"
import { z } from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"

import type { Logger } from "../log.js"

/**
 * 工具定义与执行契约。
 *
 * 一个工具就是「一段声明 + 一个执行函数」：
 * - 声明部分（name / description / input）用于生成发给模型的 JSON Schema
 * - 执行部分拿到**已经过 schema 校验**的入参，返回结构化结果与模型可见内容
 *
 * 入参校验是强制的，不能省：模型给出的 JSON 完全不可信，
 * 类型不对、字段缺失、多传字段都很常见，未校验就往下传会变成业务代码里
 * 一堆难以定位的运行时错误。
 */

/** 执行上下文。工具需要的一切外部能力都从这里拿，不直接依赖任何服务。 */
export interface ToolContext {
  sessionID: string
  /** 会话绑定的工作目录，所有相对路径以此为基准 */
  directory: string
  /** 本次调用的 ID，用于把审批请求和工具调用关联起来 */
  callID: string
  /** 回合的中止信号。长时间运行的命令必须监听它。 */
  signal: AbortSignal
  /**
   * 申请授权。
   *
   * 返回即表示已获批准；抛错表示被拒绝或回合被中断。
   * 工具不需要知道规则是怎么匹配的，只需要声明「我要做什么、涉及哪些资源」。
   */
  authorize: (input: { action: string; resources: string[]; save?: string[] }) => Promise<void>
  /**
   * 会话级状态访问。
   *
   * 绝大多数工具不需要它（它们只跟文件系统打交道）。存在的意义是让
   * todowrite 这类「维护会话自身状态」的工具也能走统一的工具接口，
   * 而不必为它开一条特殊通道。
   */
  session: {
    /** 当前任务清单 */
    todos: () => Todo[]
    /** 整表更新任务清单，会写入事件日志 */
    setTodos: (todos: Todo[]) => Promise<void>
  }
  logger: Logger
}

export interface ToolResult {
  /** 默认成功；命令非零退出等仍能产生输出的失败应显式返回 error。 */
  status?: "success" | "error"
  /** 结构化结果，供 UI 展示（模型看不到） */
  output: unknown
  /** 发给模型的内容块 */
  content: Content[]
  /** 失败时给模型和用户看的说明 */
  error?: string
  /** 副作用、修改路径和验证证据 */
  metadata?: ToolMetadata
}

export interface Tool<Input = unknown> {
  name: string
  description: string
  /** 入参 schema，同时用于校验与生成 JSON Schema */
  input: z.ZodType<Input>
  /** 权限动作名。默认与工具名相同，例如 read / edit / bash */
  permission: string
  /** 工具的默认副作用类别，工具可以在单次结果中覆盖。 */
  effect: ToolEffect
  /**
   * 从入参推导需要授权的资源清单。
   *
   * 下面几个方法刻意用「方法签名」而不是「箭头函数属性」声明：
   * 方法参数在 TypeScript 中是双变检查的，这样 Tool<具体类型> 才能被
   * 注册中心的 Tool<unknown>[] 接受。写成箭头函数属性会因为参数逆变
   * 而无法赋值，导致必须到处写类型断言或 any。
   */
  resources(input: Input): string[]
  /** 用户选择「总是允许」时要记住的模式。返回空数组表示该操作不支持记住。 */
  savePatterns(input: Input): string[]
  execute(input: Input, context: ToolContext): Promise<ToolResult>
}

export interface ToolConfig<Input> {
  name: string
  description: string
  input: z.ZodType<Input>
  permission?: string
  effect?: ToolEffect
  resources?: (input: Input) => string[]
  savePatterns?: (input: Input) => string[]
  execute: (input: Input, context: ToolContext) => Promise<ToolResult>
}

/** 定义一个工具。默认值在这里补齐，工具实现只需要写自己关心的部分。 */
export const defineTool = <Input>(config: ToolConfig<Input>): Tool<Input> => ({
  name: config.name,
  description: config.description,
  input: config.input,
  permission: config.permission ?? config.name,
  effect: config.effect ?? "state",
  // 默认资源取工具名：没有特别的资源语义时，「这个工具本身」就是被授权的对象
  resources: config.resources ?? (() => [config.name]),
  savePatterns: config.savePatterns ?? (() => []),
  execute: config.execute,
})

/**
 * 生成发给模型的工具定义。
 *
 * 两个关键参数：
 *
 * - `target: "jsonSchema7"`：必须使用 draft-7 语义。OpenAPI 3.0 风格下
 *   `.positive()` 会生成 `exclusiveMinimum: true`（布尔），而 draft-7 要求它是
 *   **数字**（`exclusiveMinimum: 0`）。DeepSeek 等实现会直接以
 *   「true is not of type "number"」拒绝整个请求，且错误信息指向的是工具名，
 *   很容易被误判成工具本身有问题。
 * - `$refStrategy: "none"`：默认行为会把重复的子 schema 抽成 `$ref`，
 *   而不少 OpenAI 兼容实现不支持 `$ref`，会在解析工具定义时直接报错。
 *   代价是定义体积略大，但工具定义本来就不多。
 */
export const toModelDefinition = (tool: Tool<unknown>): ToolDefinition => {
  const schema = zodToJsonSchema(tool.input, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>

  // 一些实现会因为 schema 里出现未知关键字而拒绝请求，把非必要的元字段去掉
  delete schema.$schema
  delete schema.definitions
  delete schema.$defs

  return { name: tool.name, description: tool.description, parameters: schema }
}

/** 只有文本内容的便捷构造。绝大多数工具只需要返回一段文本给模型。 */
export const textResult = (output: unknown, text: string): ToolResult => ({
  output,
  content: [{ type: "text", text }],
})
