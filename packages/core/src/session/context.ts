import { homedir } from "node:os"

import type { Session } from "@easycode/schema"

import { newMessageID } from "../id.js"
import { createLogger } from "../log.js"
import type { SessionHandle } from "./runtime.js"

const logger = createLogger("session.context")

/**
 * 系统上下文与 baseline 冻结。
 *
 * 核心机制（与 OpenCode 保持一致）：
 *
 * - 一个「上下文纪元」（epoch）开始时，把所有动态来源渲染成一份完整的
 *   baseline 文本，持久化保存，之后在整个 epoch 内**逐字节复用**，
 *   绝不再重新渲染。
 * - 某个来源发生变化时，不改写 baseline，而是**追加**一条系统消息告知模型新状态。
 * - 压缩完成后开启新纪元：重新渲染 baseline，并把旧纪元的中途系统消息
 *   从模型可见历史中过滤掉（它们已经被折进新的 baseline 了）。
 *
 * 为什么要这么做：主流模型服务商都有前缀缓存，命中条件是请求最前面若干 token
 * 逐字节相同。如果每轮都把「当前时间」重新渲染进系统提示词，哪怕只变一个数字，
 * 它之后的所有内容都会缓存失效；变化点越靠前，重算的代价越大。
 * 把动态信息从「请求头部」挪到「请求尾部」，就同时保住了缓存和信息的时效性。
 */

/**
 * 一个上下文来源。
 *
 * 刻意做得比 OpenCode 简单：那边是带 codec / removal 渲染器的五件套代数，
 * 这里只需要「采样一个值」和「把值渲染成文本」两件事。
 * 将来要加 AGENTS.md 注入或技能列表，往 sources 数组里加一个实现即可，接口不用动。
 */
export interface ContextSource {
  /** 稳定的命名空间键，用于比对变化，例如 "core.date" */
  key: string
  /** 采样当前值。必须是纯读取，不能有副作用。 */
  load(session: Session): Promise<unknown>
  /**
   * 把来源值渲染成模型可读的文本。
   *
   * baseline 与「更新消息」共用同一个渲染函数，因为更新消息的语义是
   * 「这是该来源的最新完整状态」——用全量覆盖而不是增量 diff，
   * 模型不需要自己去推断变化了什么。
   *
   * 注意：这个函数必须是纯函数，同样的输入必须产出同样的输出。
   * 里面不能出现 Date.now()、随机值，也不能依赖不确定的遍历顺序——
   * 一旦渲染结果不稳定，前缀缓存会静默失效，而且极难排查。
   */
  render(value: unknown): string
}

/** 一次 provider turn 之前得到的系统上下文体。 */
export interface SystemContextResult {
  /** 冻结的 baseline 原文，本 epoch 内不变 */
  baseline: string
  /** baseline 对应的事件序号，历史投影据此过滤已被折进 baseline 的系统消息 */
  baselineSeq: number
  /** 本次新增的中途系统消息文本（已写入事件日志） */
  updates: string[]
}

export interface SystemContextManager {
  /**
   * 每个 provider turn 之前调用：首次渲染并冻结 baseline，之后只做变化比对。
   * 这是唯一允许创建新 epoch 的入口（另一个是压缩完成后的 replace）。
   */
  ensure(handle: SessionHandle): Promise<SystemContextResult>
  /** 压缩完成后重建 baseline，开启新纪元 */
  replace(handle: SessionHandle): Promise<SystemContextResult>
}

/** 内置来源。顺序无关，最终渲染前会按 key 排序以保证字节稳定。 */
export const createDefaultSources = (): ContextSource[] => [environmentSource, dateSource]

/**
 * 运行环境来源。
 *
 * 它是模型理解「自己在哪台机器的哪个目录下工作」的唯一依据，
 * 也是工具解析相对路径的基准。会话与目录强绑定，所以这个值在一次会话内不会变。
 */
const environmentSource: ContextSource = {
  key: "core.environment",
  load: async (session) => ({
    directory: session.directory,
    platform: process.platform,
    arch: process.arch,
    home: homedir(),
  }),
  render: (value) => {
    const environment = value as { directory: string; platform: string; arch: string; home: string }
    return [
      "## 运行环境",
      `工作目录：${environment.directory}`,
      `操作系统：${environment.platform} (${environment.arch})`,
      `用户主目录：${environment.home}`,
      "所有工具的相对路径都以工作目录为基准。",
    ].join("\n")
  },
}

/**
 * 日期来源。
 *
 * 这是首版里唯一会真正发生变化的内置来源：会话跨越零点时，
 * 它会产生一条追加式的系统消息，而不是去改写 baseline。
 */
const dateSource: ContextSource = {
  key: "core.date",
  load: async () => new Date().toLocaleDateString("sv-SE"),
  render: (value) => `## 当前日期\n今天是 ${String(value)}。`,
}

export const createSystemContextManager = (sources: ContextSource[] = createDefaultSources()): SystemContextManager => {
  // 按 key 排序，保证渲染顺序稳定：Map 的插入顺序虽然确定，但显式排序
  // 能避免将来有人调整 sources 数组顺序时悄悄改变 baseline 字节
  const ordered = [...sources].sort((a, b) => a.key.localeCompare(b.key))

  const sample = async (session: Session): Promise<Record<string, unknown>> => {
    const entries = await Promise.all(
      ordered.map(async (source) => [source.key, await source.load(session)] as const),
    )
    return Object.fromEntries(entries)
  }

  const ensure = async (handle: SessionHandle): Promise<SystemContextResult> => {
    const session = handle.state.session
    const existing = await handle.readContext()
    const values = await sample(session)

    // 首次：渲染 baseline 并冻结
    if (!existing) {
      const baseline = renderBaseline(ordered, values)
      const baselineSeq = handle.state.lastSeq
      await handle.saveContext({ epoch: 1, baseline, lastSeen: values, baselineSeq })
      logger.info("已建立上下文纪元", { sessionID: session.id, epoch: 1, baselineSeq, baselineChars: baseline.length })
      // 首轮不产生更新消息：新渲染的 baseline 里已经包含了这些信息
      return { baseline, baselineSeq, updates: [] }
    }

    // 之后：只采样比对，baseline 原样返回
    const updates: string[] = []
    for (const source of ordered) {
      const next = values[source.key]
      if (isSameValue(existing.lastSeen[source.key], next)) continue

      const text = renderUpdate(source, next)
      await handle.append({
        type: "context.updated",
        sessionID: session.id,
        timestamp: Date.now(),
        messageID: newMessageID(),
        text,
      })
      existing.lastSeen[source.key] = next
      updates.push(text)
    }

    if (updates.length > 0) {
      await handle.saveContext(existing)
      logger.info("已追加上下文更新", { sessionID: session.id, count: updates.length, sources: ordered.length })
    }

    return { baseline: existing.baseline, baselineSeq: existing.baselineSeq, updates }
  }

  const replace = async (handle: SessionHandle): Promise<SystemContextResult> => {
    const session = handle.state.session
    const previous = await handle.readContext()
    const values = await sample(session)
    const baseline = renderBaseline(ordered, values)
    // 新纪元的 baseline 序号取当前最大序号：此后一切系统消息都大于它，
    // 而旧纪元的中途更新消息都小于它，从而被历史投影过滤掉
    const baselineSeq = handle.state.lastSeq
    const epoch = (previous?.epoch ?? 1) + 1

    await handle.saveContext({ epoch, baseline, lastSeen: values, baselineSeq })
    logger.info("已重建上下文纪元", { sessionID: session.id, epoch, baselineSeq, baselineChars: baseline.length })

    return { baseline, baselineSeq, updates: [] }
  }

  return { ensure, replace }
}

/** 把各来源渲染结果拼成完整的 baseline 文本。 */
const renderBaseline = (sources: ContextSource[], values: Record<string, unknown>): string =>
  ["# 当前场景", ...sources.map((source) => source.render(values[source.key]))].join("\n\n")

/**
 * 渲染一条中途系统消息。
 *
 * 加上一层统一的包装，是为了让模型明确知道「这是一次覆盖式更新」，
 * 而不是一段新出现的说明文字。不加这层包装时，模型有时会把新旧两份信息
 * 同时当作有效内容，导致按过期日期或过期路径行动。
 */
const renderUpdate = (source: ContextSource, value: unknown): string =>
  [`[上下文更新] 以下信息已发生变化，请以本节内容为准，忽略此前同一主题的旧值。`, source.render(value)].join("\n")

/**
 * 比较两个来源值是否相同。
 *
 * 用 JSON 序列化做比较：内置来源的值都是简单的字面量与扁平对象，
 * 不存在循环引用或键序不稳定的问题。将来如果加入结构复杂的来源，
 * 需要换成稳定的深比较实现。
 */
const isSameValue = (a: unknown, b: unknown): boolean =>
  a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
