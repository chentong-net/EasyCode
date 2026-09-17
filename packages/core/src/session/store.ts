import { appendFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { DurableEvent, Session } from "@easycode/schema"

import type { CoreConfig } from "../config.js"
import { createLogger } from "../log.js"

const logger = createLogger("session.store")

/** 把 Omit 分配到联合类型的每个成员上（普通 Omit 会把联合折叠掉）。 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** 尚未分配序号的持久化事件。序号由运行时分配，因为只有它知道当前进度。 */
export type NewDurableEvent = DistributiveOmit<DurableEvent, "seq">

/**
 * 会话级上下文状态。
 *
 * 覆盖写、不追加，与事件日志分开存放。原因是 baseline 必须能被 O(1) 读取：
 * 如果把它塞进事件流，每次启动都要重放整个日志才能知道当前 baseline 是什么。
 *
 * `lastSeen` 记录「上一次真正送进 provider turn 的来源值」，用于判断某个上下文来源
 * 是否发生变化。它与回退功能无关——EasyCode 不做回退，也不需要文件快照。
 */
export interface PersistedContext {
  /** 上下文纪元序号。每次压缩完成后加一，表示 baseline 被重新渲染 */
  epoch: number
  /** 冻结的系统上下文原文。本 epoch 内逐字节复用，不再重新渲染 */
  baseline: string
  /** 上次进入 provider turn 的各来源取值 */
  lastSeen: Record<string, unknown>
  /** baseline 对应的事件序号，历史投影据此过滤掉已被折进 baseline 的系统消息 */
  baselineSeq: number
}

/**
 * 会话存储：只负责磁盘读写，不含任何业务判断。
 *
 * 文件布局：
 * ```
 * <dataDir>/sessions/<sessionID>/session.json   会话元信息（列表页用，派生自事件日志）
 * <dataDir>/sessions/<sessionID>/events.jsonl   持久化事件，仅追加
 * <dataDir>/sessions/<sessionID>/context.json   上下文纪元状态，覆盖写
 * <dataDir>/tool-output/tool_xxx.txt            超长工具输出的落盘文件
 * ```
 *
 * 事件日志是唯一的真相来源；session.json 是为了让「会话列表」不必扫描整个日志
 * 而维护的派生缓存，缺失或损坏时会话仍可正常打开（重新从日志推导）。
 */
export interface SessionStore {
  readonly dataDir: string
  readonly sessionsDir: string
  readonly toolOutputDir: string

  sessionDirectory(sessionID: string): string
  ensureSessionDirectory(sessionID: string): Promise<void>

  /** 列出全部会话，按更新时间倒序。用于侧边栏。 */
  list(): Promise<Session[]>
  readSession(sessionID: string): Promise<Session | undefined>
  writeSession(session: Session): Promise<void>

  /** 追加一条事件到日志末尾。seq 由调用方分配。 */
  appendEvent(sessionID: string, seq: number, event: NewDurableEvent): Promise<DurableEvent>
  /** 读取日志。afterSeq 省略时读取全部。启动时调用一次，之后由运行时在内存中维护。 */
  readEvents(sessionID: string, afterSeq?: number): Promise<DurableEvent[]>

  readContext(sessionID: string): Promise<PersistedContext | undefined>
  writeContext(sessionID: string, context: PersistedContext): Promise<void>

  /** 把超长工具输出的完整内容落盘，返回文件绝对路径。 */
  saveToolOutput(content: string): Promise<string>
  /** 清理过期的工具输出文件，返回清理数量。 */
  cleanupToolOutput(maxAgeMs: number): Promise<number>
}

export const createSessionStore = (config: CoreConfig): SessionStore => {
  const sessionsDir = join(config.dataDir, "sessions")
  const toolOutputDir = join(config.dataDir, "tool-output")

  const sessionDirectory = (sessionID: string): string => join(sessionsDir, sessionID)

  const ensureSessionDirectory = async (sessionID: string): Promise<void> => {
    await mkdir(sessionDirectory(sessionID), { recursive: true })
  }

  const list = async (): Promise<Session[]> => {
    let entries: string[]
    try {
      entries = (await readdir(sessionsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch (error) {
      // 目录不存在说明还没有任何会话，这是首次启动的正常情况
      if (isNotFound(error)) return []
      throw error
    }

    const sessions = await Promise.all(entries.map((id) => readSession(id)))
    return sessions
      .filter((session): session is Session => session !== undefined)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  // 注意：这里的 readSession 在工厂内部先定义再被 list 引用，
  // 用函数声明式写法而不是 const 箭头函数以支持变量提升
  async function readSession(sessionID: string): Promise<Session | undefined> {
    const file = join(sessionDirectory(sessionID), "session.json")
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
      const result = Session.safeParse(parsed)
      if (!result.success) {
        logger.warn("session.json 结构不符合预期，已跳过该会话", { sessionID, error: result.error.message })
        return undefined
      }
      return result.data
    } catch (error) {
      if (isNotFound(error)) {
        logger.debug("会话缺少 session.json，已跳过", { sessionID })
        return undefined
      }
      logger.warn("读取 session.json 失败，已跳过该会话", { sessionID, error })
      return undefined
    }
  }

  const writeSession = async (session: Session): Promise<void> => {
    await ensureSessionDirectory(session.id)
    await writeJSONAtomic(join(sessionDirectory(session.id), "session.json"), session)
  }

  const appendEvent = async (sessionID: string, seq: number, event: NewDurableEvent): Promise<DurableEvent> => {
    const full = { ...event, seq } as DurableEvent
    await ensureSessionDirectory(sessionID)
    await appendFile(join(sessionDirectory(sessionID), "events.jsonl"), `${JSON.stringify(full)}\n`, "utf8")
    logger.debug("持久化事件", { sessionID, seq, type: full.type })
    return full
  }

  const readEvents = async (sessionID: string, afterSeq = 0): Promise<DurableEvent[]> => {
    const file = join(sessionDirectory(sessionID), "events.jsonl")
    let content: string
    try {
      content = await readFile(file, "utf8")
    } catch (error) {
      if (isNotFound(error)) return []
      throw error
    }

    const events: DurableEvent[] = []
    let skipped = 0

    for (const line of content.split("\n")) {
      if (line.trim().length === 0) continue

      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        // 最后一行可能是进程崩溃时写了一半的内容，跳过即可
        skipped += 1
        continue
      }

      const result = DurableEvent.safeParse(parsed)
      if (!result.success) {
        skipped += 1
        continue
      }
      if (result.data.seq > afterSeq) events.push(result.data)
    }

    if (skipped > 0) logger.warn("事件日志中有无法解析的行，已跳过", { sessionID, skipped })
    logger.debug("读取事件日志", { sessionID, count: events.length, afterSeq })
    return events
  }

  const readContext = async (sessionID: string): Promise<PersistedContext | undefined> => {
    const file = join(sessionDirectory(sessionID), "context.json")
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"))
      if (typeof parsed !== "object" || parsed === null) return undefined
      const context = parsed as PersistedContext
      if (typeof context.baseline !== "string" || typeof context.epoch !== "number") {
        logger.warn("context.json 结构不符合预期，将重新建立上下文纪元", { sessionID })
        return undefined
      }
      return context
    } catch (error) {
      if (isNotFound(error)) return undefined
      // 上下文文件损坏不会让会话不可用，只是需要重新渲染一次 baseline
      logger.warn("读取 context.json 失败，将重新建立上下文纪元", { sessionID, error })
      return undefined
    }
  }

  const writeContext = async (sessionID: string, context: PersistedContext): Promise<void> => {
    await ensureSessionDirectory(sessionID)
    await writeJSONAtomic(join(sessionDirectory(sessionID), "context.json"), context)
  }

  const saveToolOutput = async (content: string): Promise<string> => {
    await mkdir(toolOutputDir, { recursive: true })
    const name = `tool_${Date.now()}_${Math.random().toString(16).slice(2, 10)}.txt`
    const file = join(toolOutputDir, name)
    await writeFile(file, content, "utf8")
    logger.info("工具输出已落盘", { file, bytes: Buffer.byteLength(content, "utf8") })
    return file
  }

  const cleanupToolOutput = async (maxAgeMs: number): Promise<number> => {
    let entries: string[]
    try {
      entries = await readdir(toolOutputDir)
    } catch {
      return 0
    }

    const deadline = Date.now() - maxAgeMs
    let removed = 0
    for (const entry of entries) {
      const file = join(toolOutputDir, entry)
      try {
        const info = await stat(file)
        if (info.mtimeMs >= deadline) continue
        await unlink(file)
        removed += 1
      } catch {
        // 单个文件清理失败不影响其它文件
      }
    }
    if (removed > 0) logger.info("已清理过期的工具输出文件", { removed })
    return removed
  }

  return {
    dataDir: config.dataDir,
    sessionsDir,
    toolOutputDir,
    sessionDirectory,
    ensureSessionDirectory,
    list,
    readSession,
    writeSession,
    appendEvent,
    readEvents,
    readContext,
    writeContext,
    saveToolOutput,
    cleanupToolOutput,
  }
}

/**
 * 原子写入 JSON。
 *
 * 先写临时文件再 rename：rename 在同一文件系统内是原子操作，
 * 因此不会出现「读到写了一半的 session.json」这种情况。
 * 对 context.json 尤其重要——baseline 被截断就意味着缓存前缀作废。
 */
const writeJSONAtomic = async (file: string, value: unknown): Promise<void> => {
  const temporary = `${file}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8")
  await rename(temporary, file)
}

const isNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT"
