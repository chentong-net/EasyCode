import { chmod, mkdir } from "node:fs/promises"
import { join } from "node:path"

import type { TaskState, ToolDefinition, Usage } from "@easycode/schema"

import { buildRequestBody } from "../llm/protocol.js"
import type { LLMMessage, LLMRequest } from "../llm/types.js"
import type { Logger } from "../log.js"
import { writeFileAtomic } from "../util/atomic.js"

export type CompactionBackupReason = "automatic" | "overflow"

export interface CompactionBackup {
  readonly id: string
  readonly sessionID: string
  readonly directory: string
  readonly startedAt: number
  readonly triggerReason: CompactionBackupReason
  readonly model: string
  readonly baselineSeq: number
  readonly beforeTokens: number
  summaryCalls: number
  metadata: Record<string, unknown>
}

export interface PrepareCompactionBackupInput {
  id: string
  sessionID: string
  reason: CompactionBackupReason
  model: string
  baselineSeq: number
  system: string[]
  messages: LLMMessage[]
  tools: ToolDefinition[]
  task: TaskState | undefined
  beforeTokens: number
  budget: Record<string, number>
  toolChoice?: "auto" | "none"
}

export interface SummaryBackupInput {
  purpose: "initial" | "corrected" | "chunk" | "merge" | "retry"
  request: LLMRequest
  response: {
    text: string
    finish: string
    usage?: Usage
    validTemplate: boolean
    error?: string
    keepText: boolean
  }
}

export interface CompactionBackupStore {
  prepare(input: PrepareCompactionBackupInput): Promise<CompactionBackup | undefined>
  recordSummary(backup: CompactionBackup | undefined, input: SummaryBackupInput): Promise<void>
  finalize(
    backup: CompactionBackup | undefined,
    metadata: Record<string, unknown>,
  ): Promise<void>
  recordAfter(backupID: string | undefined, request: LLMRequest, afterTokens?: number): Promise<void>
}

/**
 * compaction（压缩）诊断文件只写入当前数据目录。所有写入都尽力而为，
 * diagnostic snapshot（快照）写入失败不能改变 Agent 的实际 compaction 结果。
 */
export const createCompactionBackupStore = (
  dataDir: string,
  logger: Logger,
): CompactionBackupStore => {
  const root = join(dataDir, "compaction-contexts")
  const backups = new Map<string, CompactionBackup>()

  const prepare = async (input: PrepareCompactionBackupInput): Promise<CompactionBackup | undefined> => {
    const startedAt = Date.now()
    const directory = join(
      root,
      safeSegment(input.sessionID),
      `${directoryTime(startedAt)}-t${input.beforeTokens}-${input.id}`,
    )
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700).catch(() => undefined)
      const backup: CompactionBackup = {
        id: input.id,
        sessionID: input.sessionID,
        directory,
        startedAt,
        triggerReason: input.reason,
        model: input.model,
        baselineSeq: input.baselineSeq,
        beforeTokens: input.beforeTokens,
        summaryCalls: 0,
        metadata: {
          version: 1,
          id: input.id,
          sessionID: input.sessionID,
          triggerReason: input.reason,
          model: input.model,
          baselineSeq: input.baselineSeq,
          beforeTokens: input.beforeTokens,
          budget: input.budget,
          ...timeInfo(startedAt),
        },
      }
      backups.set(input.id, backup)
      await writeJSON(join(directory, "before.json"), {
        ...backupMetadata(backup),
        stage: "before",
        request: requestSnapshot({
          model: input.model,
          system: input.system,
          messages: input.messages,
          tools: input.tools,
          maxOutputTokens: input.budget.outputTokens,
          ...(input.toolChoice === undefined ? {} : { toolChoice: input.toolChoice }),
        }),
        task: input.task,
      })
      await writeJSON(join(directory, "metadata.json"), backup.metadata)
      return backup
    } catch (error) {
      logger.warn("无法创建 compaction 上下文诊断", { sessionID: input.sessionID, id: input.id, error })
      return undefined
    }
  }

  const recordSummary = async (
    backup: CompactionBackup | undefined,
    input: SummaryBackupInput,
  ): Promise<void> => {
    if (!backup) return
    backup.summaryCalls += 1
    const sequence = String(backup.summaryCalls).padStart(3, "0")
    const directory = join(backup.directory, "summaries")
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700).catch(() => undefined)
      await writeJSON(join(directory, `${sequence}.json`), {
        version: 1,
        sequence: backup.summaryCalls,
        purpose: input.purpose,
        request: requestSnapshot(input.request),
        response: {
          text: input.response.keepText ? input.response.text : undefined,
          textLength: input.response.text.length,
          finish: input.response.finish,
          usage: input.response.usage,
          validTemplate: input.response.validTemplate,
          error: input.response.error,
        },
      })
    } catch (error) {
      logger.warn("无法写入摘要请求诊断", { sessionID: backup.sessionID, id: backup.id, error })
    }
  }

  const finalize = async (
    backup: CompactionBackup | undefined,
    metadata: Record<string, unknown>,
  ): Promise<void> => {
    if (!backup) return
    backup.metadata = {
      ...backup.metadata,
      ...metadata,
      summaryCalls: backup.summaryCalls,
      ...timeInfo(Date.now(), "completed"),
      durationMs: Date.now() - backup.startedAt,
    }
    try {
      await writeJSON(join(backup.directory, "metadata.json"), backup.metadata)
      if (metadata.status !== "completed") backups.delete(backup.id)
    } catch (error) {
      logger.warn("无法写入 compaction 诊断元数据", { sessionID: backup.sessionID, id: backup.id, error })
    }
  }

  const recordAfter = async (
    backupID: string | undefined,
    request: LLMRequest,
    afterTokens?: number,
  ): Promise<void> => {
    if (!backupID) return
    const backup = backups.get(backupID)
    if (!backup) return
    try {
      await writeJSON(join(backup.directory, "after.json"), {
        ...backupMetadata(backup),
        stage: "after",
        request: requestSnapshot(request),
      })
      backup.metadata = {
        ...backup.metadata,
        ...timeInfo(Date.now(), "afterCaptured"),
        afterRequest: {
          systemParts: request.system.length,
          messages: request.messages.length,
          tools: request.tools.length,
          maxOutputTokens: request.maxOutputTokens,
          afterTokens,
        },
      }
      await writeJSON(join(backup.directory, "metadata.json"), backup.metadata)
    } catch (error) {
      logger.warn("无法写入 compaction 后的上下文诊断", { sessionID: backup.sessionID, id: backup.id, error })
    } finally {
      backups.delete(backupID)
    }
  }

  return { prepare, recordSummary, finalize, recordAfter }
}

const backupMetadata = (backup: CompactionBackup) => ({
  version: 1,
  id: backup.id,
  sessionID: backup.sessionID,
  ...timeInfo(backup.startedAt),
  triggerReason: backup.triggerReason,
  model: backup.model,
  baselineSeq: backup.baselineSeq,
  beforeTokens: backup.beforeTokens,
})

const directoryTime = (timestamp: number): string => {
  const date = new Date(timestamp)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
  ].join("")
}

const timeInfo = (timestamp: number, prefix = "started") => ({
  [`${prefix}At`]: new Date(timestamp).toISOString(),
  [`${prefix}AtLocal`]: localISOString(timestamp),
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown",
})

const localISOString = (timestamp: number): string => {
  const date = new Date(timestamp)
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? "+" : "-"
  const absolute = Math.abs(offset)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, "0")}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  )
}

const pad = (value: number): string => String(value).padStart(2, "0")

const requestSnapshot = (request: {
  model: string
  system: string[]
  messages: LLMMessage[]
  tools: ToolDefinition[]
  toolChoice?: "auto" | "none"
  maxOutputTokens?: number
  temperature?: number
}) => ({
  request: {
    model: request.model,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    toolChoice: request.toolChoice,
    maxOutputTokens: request.maxOutputTokens,
    temperature: request.temperature,
  },
  wire: buildRequestBody({
    model: request.model,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
    ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
    ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  }),
})

const writeJSON = async (file: string, value: unknown): Promise<void> => {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
  await chmod(file, 0o600).catch(() => undefined)
}

const safeSegment = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, "_")
