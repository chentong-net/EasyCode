import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { Agent, PermissionReply, PermissionRequest, PermissionRule } from "@easycode/schema"

import type { CoreConfig } from "../config.js"
import { PermissionDeclinedError } from "../errors.js"
import { newPermissionRequestID } from "../id.js"
import { createLogger, type Logger } from "../log.js"
import type { SessionHandle } from "../session/runtime.js"
import { evaluateResources } from "./rules.js"

/**
 * 权限服务。
 *
 * 一次授权检查的结果有三种走向：
 * - `allow`：直接放行
 * - `deny`：抛出 PermissionDeclinedError，整个回合停止
 * - `ask`：把请求写入事件日志并挂起，等用户在前端点「允许一次 / 总是允许 / 拒绝」
 *
 * 「写入事件日志」这一步不能省。如果待审批状态只存在内存里，
 * 那么进程重启或渲染进程重连之后，界面会显示一张永远转圈的审批卡片，
 * 而等待它的那段代码早已不复存在。写进日志之后，重启时会由
 * 会话加载流程统一把它标记为「已失效」。
 */

interface SavedPermission {
  /** 规则只在创建它的工作目录下生效，避免在 A 项目点的「总是允许」影响 B 项目 */
  directory: string
  action: string
  resource: string
}

interface ReplyResult {
  reply: PermissionReply
  feedback?: string
}

type Waiter = (result: ReplyResult) => void

export interface PermissionAssertInput {
  handle: SessionHandle
  agent: Agent
  /** 发起申请的工具调用 ID，用于把审批卡片与工具调用关联起来 */
  callID: string
  /** 动作名，例如 bash / edit / external_directory */
  action: string
  /** 本次申请覆盖的资源清单 */
  resources: string[]
  /** 用户选择「总是允许」时要记住的模式；为空表示该申请不支持记住 */
  save: string[]
  signal?: AbortSignal
}

export interface PermissionReplyInput {
  handle: SessionHandle
  requestID: string
  reply: PermissionReply
  feedback?: string
}

export interface PermissionService {
  /** 授权检查。allow 直接返回；ask 挂起等待；deny 或用户拒绝时抛 PermissionDeclinedError。 */
  assert(input: PermissionAssertInput): Promise<void>
  /** 对某个待审批请求作出回应 */
  reply(input: PermissionReplyInput): Promise<void>
  /** 待审批请求列表，按发起时间正序 */
  pending(handle: SessionHandle): PermissionRequest[]
  /** 某个工作目录下已保存的规则 */
  savedRules(directory: string): Promise<PermissionRule[]>
}

export const createPermissionService = (deps: { config: CoreConfig; logger?: Logger }): PermissionService => {
  const logger = deps.logger ?? createLogger("permission")
  const storageFile = join(deps.config.dataDir, "permissions.json")

  /** 已保存的规则。首次访问时从磁盘加载，之后以内存为准。 */
  let saved: SavedPermission[] | undefined
  /** 正在等待用户回应的审批请求 */
  const waiters = new Map<string, Waiter>()

  const loadSaved = async (): Promise<SavedPermission[]> => {
    if (saved) return saved
    try {
      const parsed: unknown = JSON.parse(await readFile(storageFile, "utf8"))
      const rules = (parsed as { rules?: unknown }).rules
      saved = Array.isArray(rules) ? (rules as SavedPermission[]) : []
    } catch {
      // 文件不存在或损坏都视为「还没有任何已保存规则」，不影响功能
      saved = []
    }
    return saved
  }

  const persistSaved = async (rules: SavedPermission[]): Promise<void> => {
    saved = rules
    await writeFile(storageFile, JSON.stringify({ rules }, null, 2), "utf8")
  }

  const rulesFor = async (directory: string): Promise<PermissionRule[]> =>
    (await loadSaved())
      .filter((rule) => rule.directory === directory)
      .map((rule) => ({ action: rule.action, resource: rule.resource, effect: "allow" as const }))

  const assert = async (input: PermissionAssertInput): Promise<void> => {
    const directory = input.handle.state.session.directory
    // 规则集按优先级从低到高传入：agent 默认规则在前，用户保存的规则在后
    const decision = evaluateResources(input.action, input.resources, [
      input.agent.permissions,
      await rulesFor(directory),
    ])

    if (decision.effect === "allow") return

    if (decision.effect === "deny") {
      logger.info("权限规则拒绝了操作", {
        sessionID: input.handle.id,
        action: input.action,
        resources: input.resources,
      })
      throw new PermissionDeclinedError(`权限规则不允许执行该操作（${input.action}）`)
    }

    const requestID = newPermissionRequestID()
    await input.handle.append({
      type: "permission.asked",
      sessionID: input.handle.id,
      timestamp: Date.now(),
      requestID,
      callID: input.callID,
      action: input.action,
      resources: input.resources,
      save: input.save,
    })

    logger.info("等待用户审批", {
      sessionID: input.handle.id,
      requestID,
      action: input.action,
      resources: input.resources,
    })

    const result = await wait(requestID, input.signal)

    if (result === "aborted") {
      // 中断时也要写一条回应事件，否则日志里会留下一个永远悬空的审批请求
      await input.handle.append({
        type: "permission.replied",
        sessionID: input.handle.id,
        timestamp: Date.now(),
        requestID,
        reply: "reject",
        feedback: "回合已中断，审批已取消",
      })
      throw new PermissionDeclinedError("回合已中断，审批已取消")
    }

    if (result.reply === "reject") {
      logger.info("用户拒绝了操作", { sessionID: input.handle.id, requestID, feedback: result.feedback })
      throw new PermissionDeclinedError(
        result.feedback && result.feedback.length > 0 ? `用户拒绝执行：${result.feedback}` : "用户拒绝执行该操作",
      )
    }

    if (result.reply === "always" && input.save.length > 0) {
      await remember(directory, input.action, input.save)
    }
  }

  const remember = async (directory: string, action: string, patterns: string[]): Promise<void> => {
    const rules = [...(await loadSaved())]
    let added = 0
    for (const resource of patterns) {
      const exists = rules.some(
        (rule) => rule.directory === directory && rule.action === action && rule.resource === resource,
      )
      if (exists) continue
      rules.push({ directory, action, resource })
      added += 1
    }
    if (added === 0) return
    await persistSaved(rules)
    logger.info("已记住授权规则", { directory, action, added })
  }

  /**
   * 挂起等待用户回应。
   *
   * 必须同时监听中止信号：用户点了「中断」之后，那段等待代码如果还在挂起，
   * 会话的中断流程就会永远等不到结束，表现为「点了停止但界面一直转圈」。
   */
  const wait = (requestID: string, signal: AbortSignal | undefined): Promise<ReplyResult | "aborted"> => {
    if (signal?.aborted) return Promise.resolve("aborted")

    return new Promise<ReplyResult | "aborted">((resolve) => {
      const onAbort = () => {
        waiters.delete(requestID)
        resolve("aborted")
      }

      signal?.addEventListener("abort", onAbort, { once: true })

      waiters.set(requestID, (result) => {
        signal?.removeEventListener("abort", onAbort)
        resolve(result)
      })
    })
  }

  const reply = async (input: PermissionReplyInput): Promise<void> => {
    if (!input.handle.state.pendingPermissions.has(input.requestID)) {
      throw new Error("审批请求不存在或已经处理过了")
    }

    // 先落盘再唤醒等待方：反过来的话，如果写盘失败，等待方已经被放行，
    // 日志里却没有任何「已批准」的记录
    await input.handle.append({
      type: "permission.replied",
      sessionID: input.handle.id,
      timestamp: Date.now(),
      requestID: input.requestID,
      reply: input.reply,
      ...(input.feedback && input.feedback.length > 0 ? { feedback: input.feedback } : {}),
    })

    const waiter = waiters.get(input.requestID)
    waiters.delete(input.requestID)
    waiter?.({ reply: input.reply, ...(input.feedback ? { feedback: input.feedback } : {}) })
  }

  return {
    assert,
    reply,
    pending: (handle) => [...handle.state.pendingPermissions.values()].sort((a, b) => a.createdAt - b.createdAt),
    savedRules: rulesFor,
  }
}
