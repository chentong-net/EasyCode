import type {
  Agent,
  Content,
  Delivery,
  TaskOutcomeStatus,
  TaskState,
  ToolMetadata,
  Usage,
} from "@easycode/schema"

import { resolveAgent, type AgentRegistry } from "../agent.js"
import type { CoreConfig } from "../config.js"
import { PermissionDeclinedError } from "../errors.js"
import { newMessageID } from "../id.js"
import { describeError, isAbortError, LLMError } from "../llm/error.js"
import type { LLMClient, LLMRequest } from "../llm/types.js"
import { createLogger, type Logger } from "../log.js"
import type { PermissionService } from "../permission/service.js"
import type { CompactionManager } from "../session/compaction.js"
import type { SystemContextManager } from "../session/context.js"
import { buildLLMMessages } from "../session/history.js"
import { pendingInputList, type ProjectedState } from "../session/projector.js"
import { DEFAULT_SESSION_TITLE, type RunDriver, type SessionHandle, type SessionManager } from "../session/runtime.js"
import { amendTask, createTaskState, finishTask, moveTaskPhase, recordVerification } from "../session/task.js"
import type { EventHub } from "../events.js"
import type { ToolRegistry } from "../tool/registry.js"

/**
 * Agent 循环。
 *
 * 整个 Core 的心脏，结构与 OpenCode 保持一致。四个不变量在这里落地，
 * 它们决定了这套实现能不能正确处理中断、崩溃和长会话：
 *
 * 1. **工具调用先落日志再执行**：`tool.called` 事件必须在真正执行之前写入，
 *    否则进程崩溃后无法判断某个副作用是否已经发生。
 * 2. **一次 provider turn 只调一次 `llm.stream`**：不在内存里做隐式的工具循环，
 *    每一轮都从事件日志重新读取历史。这样「进程重启后继续」和「正常运行」
 *    走的是同一条代码路径。
 * 3. **新用户输入只在 provider turn 之前提升**：用户随时可以插话，
 *    但插话内容只在一个安全边界（下一次调用模型之前）进入历史，
 *    不会把正在进行的这一轮请求撕成两半。
 * 4. **工具全部结算完才考虑续跑**：模型可能一次请求多个工具，
 *    必须等它们都结束、结果都落盘之后，才发起下一轮请求。
 *
 * 外层是 drain（消费输入队列），内层是 turn（一次模型调用）。
 */

/** 一个会话的运行状态。由 runner 持有，不放进会话句柄，避免会话层反向依赖执行层。 */
interface RunControl {
  running: boolean
  /** 运行期间又收到了唤醒请求 */
  pending: boolean
  controller?: AbortController
  task?: Promise<void>
}

export interface RunnerDeps {
  config: CoreConfig
  llm: LLMClient
  sessions: SessionManager
  agents: AgentRegistry
  tools: ToolRegistry
  permissions: PermissionService
  compaction: CompactionManager
  context: SystemContextManager
  hub: EventHub
  logger?: Logger
}

export const createRunner = (deps: RunnerDeps): RunDriver => {
  const logger = deps.logger ?? createLogger("runner")
  const controls = new Map<string, RunControl>()

  const controlOf = (sessionID: string): RunControl => {
    const existing = controls.get(sessionID)
    if (existing) return existing
    const created: RunControl = { running: false, pending: false }
    controls.set(sessionID, created)
    return created
  }

  const wake = (sessionID: string): void => {
    const state = controlOf(sessionID)
    if (state.running) {
      state.pending = true
      logger.debug("会话正在运行，已记录待处理的唤醒", { sessionID })
      return
    }
    start(sessionID, state)
  }

  const start = (sessionID: string, state: RunControl): void => {
    // 这几行必须在任何 await 之前执行：用户完全可能「发完消息立刻点中断」，
    // 如果此时 running 还是 false，中断请求会被当成「会话空闲」而丢弃
    state.running = true
    state.pending = false
    const controller = new AbortController()
    state.controller = controller

    state.task = drain(sessionID, controller)
      .catch((error) => {
        logger.error("回合执行异常终止", { sessionID, error })
      })
      .finally(() => {
        const wasAborted = controller.signal.aborted
        state.running = false
        state.controller = undefined
        state.task = undefined
        // 中断优先：被中断时不再自动续跑
        const shouldRestart = state.pending && !wasAborted
        state.pending = false
        if (shouldRestart) start(sessionID, state)
      })
  }

  const interrupt = async (sessionID: string): Promise<void> => {
    const state = controls.get(sessionID)
    if (!state?.running) {
      logger.debug("会话没有运行中的回合，中断请求已忽略", { sessionID })
      return
    }

    logger.info("收到中断请求", { sessionID })
    state.pending = false

    const handle = await deps.sessions.handle(sessionID)
    await handle.append({ type: "run.interrupted", sessionID, timestamp: Date.now() })
    state.controller?.abort()

    // 等当前回合真正退出，否则调用方紧接着发起的下一轮会和它并发，
    // 造成两条助手消息交错写入同一段历史
    await state.task?.catch(() => undefined)
  }

  const shutdown = async (): Promise<void> => {
    const running = [...controls.values()].filter((state) => state.running)
    if (running.length === 0) return
    logger.info("正在中止运行中的回合", { count: running.length })
    for (const state of running) {
      state.pending = false
      state.controller?.abort()
    }
    await Promise.allSettled(running.map((state) => state.task ?? Promise.resolve()))
  }

  /* ------------------------------------------------------------------------ */
  /* 外层循环：消费输入队列                                                     */
  /* ------------------------------------------------------------------------ */

  const drain = async (sessionID: string, controller: AbortController): Promise<void> => {
    const handle = await deps.sessions.handle(sessionID)
    const agent = resolveAgent(deps.agents, handle.state.session.agent)

    logger.info("开始执行回合", {
      sessionID,
      agent: agent.id,
      model: handle.state.session.model,
      pendingInputs: handle.state.pendingInputs.size,
    })

    // 首次进入时的提升方式：有插话就按插话提升，否则按排队提升
    let promotion: Delivery | undefined = hasPendingInput(handle.state, "steer")
      ? "steer"
      : hasPendingInput(handle.state, "queue")
        ? "queue"
        : undefined

    await handle.append({ type: "run.started", sessionID, timestamp: Date.now() })

    try {
      while (!controller.signal.aborted) {
        let step = 1
        let needsContinuation = true

        while (needsContinuation) {
          if (controller.signal.aborted) break

          const result = await runTurn({ handle, agent, controller, step, promotion })
          needsContinuation = result.needsContinuation
          step = result.step + 1

          // 一轮内的后续 provider turn 都按插话方式提升：
          // 新输入会重置步数预算，因为它很可能改变了任务方向
          promotion = "steer"
          if (!needsContinuation) needsContinuation = hasPendingInput(handle.state, "steer")
        }

        if (controller.signal.aborted) break

        // 排队输入只在会话即将空闲时提升一条，然后重新判断是否还要继续
        if (!hasPendingInput(handle.state, "queue")) break
        promotion = "queue"
      }
    } finally {
      await finalizeTask(handle, controller.signal.aborted)
      // 空闲事件必须写：界面靠它撤销「正在运行」状态。
      // 放在 finally 里是因为无论是正常结束、异常还是中断，
      // 界面都必须从运行态回到空闲态，否则停止按钮会一直挂着
      await handle.append({ type: "run.idle", sessionID, timestamp: Date.now() })
      logger.info("回合执行结束", { sessionID })
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 一次 provider turn                                                        */
  /* ------------------------------------------------------------------------ */

  interface TurnParams {
    handle: SessionHandle
    agent: Agent
    controller: AbortController
    step: number
    promotion: Delivery | undefined
    /** 是否已经因为压缩重建过请求，避免同一步里反复压缩 */
    compactedOnce?: boolean
  }

  interface TurnResult {
    needsContinuation: boolean
    step: number
  }

  const runTurn = async (params: TurnParams): Promise<TurnResult> => {
    const { handle, agent } = params
    const session = handle.state.session
    const signal = params.controller.signal

    // 1. 提升输入。有输入被提升时重置步数预算。
    const promoted = await promoteInputs(handle, params.promotion)
    const step = promoted.count > 0 ? 1 : params.step
    await ensureTask(handle, promoted.texts)

    // 2. 系统上下文。首次进入会渲染并冻结 baseline，之后只做变化比对。
    const systemContext = await deps.context.ensure(handle)

    // 3. 组装请求：历史 + 工具定义 + 系统提示词（agent 提示词在前，baseline 在后）
    const messages = buildLLMMessages(handle.state, { baselineSeq: systemContext.baselineSeq })
    const isLastStep = step >= agent.steps
    const tools = isLastStep ? [] : deps.tools.definitions()
    const system = [agent.system, systemContext.baseline].filter((part) => part.length > 0)

    // 4. 压缩检查。压缩过就重建请求（baseline 会换成新纪元的版本）。
    if (params.compactedOnce !== true) {
      const compacted = await deps.compaction.compactIfNeeded({
        handle,
        baselineSeq: systemContext.baselineSeq,
        system,
        tools,
        messages,
        signal,
      })
      if (compacted) {
        // 压缩完成后开启新的上下文纪元：重渲染 baseline，
        // 旧纪元的中途系统消息就此退出模型历史
        await deps.context.replace(handle)
        return runTurn({ ...params, step, promotion: undefined, compactedOnce: true })
      }
    }

    const request: LLMRequest = {
      model: session.model,
      system,
      messages,
      tools,
      ...(isLastStep ? { toolChoice: "none" as const } : {}),
      sessionID: session.id,
    }

    if (isLastStep) {
      logger.info("已达到步数上限，本轮禁用工具以强制收尾", { sessionID: session.id, steps: agent.steps })
    }

    // 取消信号由 streamTurn 创建：它需要为本轮单独派生一个控制器，
    // 以便「用户拒绝授权」时只取消本轮，而不影响整个回合
    return streamTurn({ handle, agent, request, step, isLastStep, parentSignal: signal })
  }

  /* ------------------------------------------------------------------------ */
  /* 流式消费与工具结算                                                        */
  /* ------------------------------------------------------------------------ */

  interface StreamParams {
    handle: SessionHandle
    agent: Agent
    /** 尚未注入取消信号的请求；信号由 streamTurn 统一派生，理由见 createTurnController */
    request: LLMRequest
    step: number
    isLastStep: boolean
    /** 外层回合的取消信号。它被中止代表用户点了「中断」 */
    parentSignal: AbortSignal
  }

  interface AttemptParams {
    handle: SessionHandle
    agent: Agent
    /** 已经带上取消信号的完整请求 */
    request: LLMRequest
    step: number
    isLastStep: boolean
    /** 本轮自己的取消控制器。取代用户拒绝授权时用它取消剩余的工具调用 */
    turn: AbortController
    /** 等同于 request.signal，单独传一份是为了避免每处都要做非空判断 */
    signal: AbortSignal
    /** 外层回合信号，用于区分「用户拒绝」与「用户中断」 */
    parentSignal: AbortSignal
  }

  /** 单次尝试的结果。overflow 为 true 表示上下文超限且还没产出内容，值得压缩后重试。 */
  interface AttemptResult extends TurnResult {
    overflow: boolean
  }

  /**
   * 流式消费一次模型响应。
   *
   * 外层包一层重试循环，专门处理「上下文超限」：provider 在助手消息还没产出
   * 任何内容时就报超限，说明是历史太大而不是模型生成的问题，
   * 此时压缩一次再试是安全且通常有效的。只重试一次，避免陷入循环。
   */
  const streamTurn = async (params: StreamParams): Promise<TurnResult> => {
    const turn = createTurnController(params.parentSignal)
    const request: LLMRequest = { ...params.request, signal: turn.controller.signal }

    try {
      let attempt = 0

      while (true) {
        const result = await attemptStream({
          handle: params.handle,
          agent: params.agent,
          request,
          step: params.step,
          isLastStep: params.isLastStep,
          turn: turn.controller,
          signal: turn.controller.signal,
          parentSignal: params.parentSignal,
        })
        if (!result.overflow || attempt >= 1) return result

        attempt += 1
        const compacted = await deps.compaction.compactAfterOverflow({
          handle: params.handle,
          baselineSeq: (await deps.context.ensure(params.handle)).baselineSeq,
          system: request.system,
          tools: request.tools,
          messages: request.messages,
          signal: turn.controller.signal,
        })

        if (!compacted) {
          logger.warn("上下文超限但压缩未能完成，本轮以失败结束", { sessionID: params.handle.id })
          return result
        }

        await deps.context.replace(params.handle)
        logger.info("压缩完成，重试本次请求", { sessionID: params.handle.id })
      }
    } finally {
      // 必须解绑：否则一个长回合的每一步都会在外层信号上留下一个监听器
      turn.dispose()
    }
  }

  const attemptStream = async (params: AttemptParams): Promise<AttemptResult> => {
    const { handle, agent } = params
    const session = handle.state.session
    const signal = params.signal
    const messageID = newMessageID()
    const startedAt = Date.now()

    await handle.append({
      type: "message.started",
      sessionID: session.id,
      timestamp: startedAt,
      messageID,
      model: session.model,
    })

    /** 当前正在累积的 part。模型的输出会在「文本」与「推理」之间来回切换，切换时结算上一段。 */
    let currentPart: { kind: "text" | "reasoning"; index: number; buffer: string } | undefined
    let partIndex = 0
    const settlements: Array<Promise<void>> = []
    let needsContinuation = false
    let usage: Usage | undefined
    let finishReason = ""
    let produced = false
    let declined: string | undefined

    const publishLive = (event: { type: "text.delta" | "reasoning.delta"; index: number; text: string }): void => {
      deps.hub.publish({
        type: event.type,
        sessionID: session.id,
        timestamp: Date.now(),
        messageID,
        index: event.index,
        text: event.text,
      })
    }

    /** 结算当前 part：把累积的文本作为权威值写入事件日志。 */
    const flushPart = async (): Promise<void> => {
      const part = currentPart
      currentPart = undefined
      if (!part || part.buffer.length === 0) return
      await handle.append({
        type: part.kind === "text" ? "part.text" : "part.reasoning",
        sessionID: session.id,
        timestamp: Date.now(),
        messageID,
        index: part.index,
        text: part.buffer,
      })
    }

    const appendDelta = async (kind: "text" | "reasoning", text: string): Promise<void> => {
      if (currentPart?.kind !== kind) {
        await flushPart()
        currentPart = { kind, index: partIndex, buffer: "" }
        partIndex += 1
      }
      currentPart.buffer += text
      publishLive({
        type: kind === "text" ? "text.delta" : "reasoning.delta",
        index: currentPart.index,
        text,
      })
    }

    /**
     * 用户拒绝授权时的收尾。
     *
     * 走到这里说明某次工具调用被用户否决了。工具结果已经落盘（拒绝原因会作为
     * 工具错误返回给模型），这里只需要结束消息并让整个回合停下来。
     * 让模型换个方式继续尝试同一件事是危险的——用户已经明确说「不要做」。
     */
    const finishDeclined = async (): Promise<AttemptResult> => {
      logger.info("用户拒绝授权，回合停止", { sessionID: session.id, message: declined })
      await finishTurn(handle, session.id, settlements, messageID, {
        finish: "declined",
        usage,
        error: declined,
      })
      const task = handle.state.task
      if (task && !task.outcome) {
        await appendTask(
          handle,
          finishTask(moveTaskPhase(task, "blocked"), {
            status: "blocked",
            summary: declined ?? "用户拒绝执行该操作",
            remaining: ["用户拒绝后剩余工作未继续执行。"],
            timestamp: Date.now(),
          }),
        )
      }
      return { needsContinuation: false, step: params.step, overflow: false }
    }

    /**
     * 判断本次结束是否应当归因为「用户拒绝」。
     *
     * 外层回合被中断时，挂起的审批会被取消并同样抛权限类错误，因此必须排除中断：
     * 用户点的是「停止」而不是「拒绝」，两者对用户的意义完全不同。
     */
    const declinedThisTurn = (): boolean => declined !== undefined && !params.parentSignal.aborted

    try {
      for await (const event of deps.llm.stream(params.request)) {
        switch (event.type) {
          case "text.delta":
            produced = true
            await appendDelta("text", event.text)
            break

          case "reasoning.delta":
            produced = true
            await appendDelta("reasoning", event.text)
            break

          case "tool.input.delta":
            produced = true
            // 工具入参的分片只用于实时展示，权威值在 tool.call 里
            deps.hub.publish({
              type: "tool.input.delta",
              sessionID: session.id,
              timestamp: Date.now(),
              callID: event.callID,
              text: event.text,
            })
            break

          case "tool.call": {
            produced = true
            await flushPart()
            const index = partIndex
            partIndex += 1

            // 先落日志再执行：这是崩溃后能判断「哪些副作用可能已发生」的唯一依据
            await handle.append({
              type: "tool.called",
              sessionID: session.id,
              timestamp: Date.now(),
              messageID,
              index,
              callID: event.callID,
              name: event.name,
              input: event.input,
            })

            if (params.isLastStep) {
              // 步数已用尽，工具不再执行。仍然要写一条结果，
              // 否则历史里会出现没有配对结果的工具调用，后续请求会被服务端拒绝
              settlements.push(
                appendToolSettlement(handle, session.id, {
                  callID: event.callID,
                  status: "error",
                  error: "已达到本轮的步数上限，该工具调用未执行",
                }),
              )
              break
            }

            needsContinuation = true
            settlements.push(
              settleTool({
                handle,
                agent,
                messageID,
                callID: event.callID,
                name: event.name,
                input: event.input,
                parseError: event.parseError,
                signal,
                onDeclined: (message) => {
                  declined = message
                  // 用户已经明确表示不要做这件事：立刻取消本轮其余的工具调用，
                  // 否则并发执行的其它工具会在用户拒绝之后继续产生副作用
                  params.turn.abort()
                },
              }),
            )
            break
          }

          case "usage":
            usage = event.usage
            break

          case "finish":
            finishReason = event.reason
            break
        }
      }
    } catch (error) {
      await flushPart()

      // 拒绝授权会主动取消本轮，抛出的异常只是「取消」的结果，
      // 应当按「用户拒绝」结束，而不是笼统地报成失败或中断
      if (declinedThisTurn()) return finishDeclined()

      const failure = normalizeFailure(error, signal)

      // 助手还没产出任何内容就报超限：这是历史过大导致的，压缩后重试
      if (failure instanceof LLMError && failure.kind === "context_overflow" && !produced) {
        await handle.append({
          type: "message.ended",
          sessionID: session.id,
          timestamp: Date.now(),
          messageID,
          finish: "compacted",
          ...(usage ? { usage } : {}),
        })
        logger.info("provider 报告上下文超限，准备压缩后重试", { sessionID: session.id })
        return { needsContinuation: false, step: params.step, overflow: true }
      }

      logger.warn("本轮请求失败", { sessionID: session.id, messageID, error: describeError(error) })
      await finishTurn(handle, session.id, settlements, messageID, {
        finish: isAbortLike(failure) ? "interrupted" : "error",
        usage,
        error: describeError(failure),
      })
      return { needsContinuation: false, step: params.step, overflow: false }
    }

    await flushPart()

    // 等所有工具结算完成。模型可能一次请求多个工具，必须全部结束才能继续。
    const settled = await Promise.allSettled(settlements)
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        logger.error("工具结算任务异常", { sessionID: session.id, error: describeError(outcome.reason) })
      }
    }

    // 兜底：任何仍然处于 pending 的工具调用都要补一条结果，
    // 否则下一次请求会因为「工具调用没有配对结果」被服务端拒绝
    await settlePendingTools(handle, session.id, messageID)

    if (declinedThisTurn()) return finishDeclined()

    const aborted = signal.aborted
    await finishTurn(handle, session.id, [], messageID, {
      finish: aborted ? "interrupted" : finishReason || "stop",
      usage,
    })

    const task = handle.state.task
    const needsVerification =
      !aborted &&
      !params.isLastStep &&
      task !== undefined &&
      task.verificationStatus === "stale" &&
      task.changedPaths.length > 0 &&
      task.verificationNudgedRevision !== task.mutationRevision

    if (needsVerification && task) {
      await appendTask(
        handle,
        moveTaskPhase(
          {
            ...task,
            verificationNudgedRevision: task.mutationRevision,
          },
          "verify",
        ),
      )
      needsContinuation = true
    }

    logger.info("本轮结束", {
      sessionID: session.id,
      messageID,
      finish: aborted ? "interrupted" : finishReason || "stop",
      needsContinuation: needsContinuation && !aborted,
      durationMs: Date.now() - startedAt,
    })

    return { needsContinuation: needsContinuation && !aborted, step: params.step, overflow: false }
  }

  /** 写入消息结束事件。所有结束路径都必须经过它，保证消息不会悬挂在「进行中」。 */
  const finishTurn = async (
    handle: SessionHandle,
    sessionID: string,
    pending: Array<Promise<void>>,
    messageID: string,
    input: { finish: string; usage?: Usage; error?: string },
  ): Promise<void> => {
    if (pending.length > 0) await Promise.allSettled(pending)
    await handle.append({
      type: "message.ended",
      sessionID,
      timestamp: Date.now(),
      messageID,
      finish: input.finish,
      ...(input.usage ? { usage: input.usage } : {}),
      ...(input.error ? { error: input.error } : {}),
    })
  }

  interface SettleToolInput {
    handle: SessionHandle
    agent: Agent
    messageID: string
    callID: string
    name: string
    input: unknown
    parseError?: string
    signal: AbortSignal | undefined
    onDeclined: (message: string) => void
  }

  /** 执行一次工具调用并把结果写入事件日志。 */
  const settleTool = async (params: SettleToolInput): Promise<void> => {
    const { handle } = params
    const session = handle.state.session

    try {
      const settlement = await deps.tools.settle({
        call: { callID: params.callID, name: params.name, input: params.input },
        ...(params.parseError === undefined ? {} : { parseError: params.parseError }),
        sessionID: session.id,
        directory: session.directory,
        signal: params.signal ?? new AbortController().signal,
        authorize: async ({ callID, action, resources, save }) => {
          await deps.permissions.assert({
            handle,
            agent: params.agent,
            callID,
            action,
            resources,
            save,
            ...(params.signal ? { signal: params.signal } : {}),
          })
        },
        session: {
          todos: () => handle.state.session.todos,
          setTodos: async (todos) => {
            await handle.append({
              type: "session.todos",
              sessionID: session.id,
              timestamp: Date.now(),
              todos,
            })
          },
        },
      })

      await appendToolSettlement(handle, session.id, {
        callID: params.callID,
        status: settlement.status,
        ...(settlement.output === undefined ? {} : { output: settlement.output }),
        ...(settlement.content === undefined ? {} : { content: settlement.content }),
        ...(settlement.outputPaths === undefined ? {} : { outputPaths: settlement.outputPaths }),
        ...(settlement.error === undefined ? {} : { error: settlement.error }),
        ...(settlement.metadata === undefined ? {} : { metadata: settlement.metadata }),
      })
      await updateTaskFromTool(handle, {
        callID: params.callID,
        name: params.name,
        input: params.input,
        status: settlement.status,
        output: settlement.output,
        error: settlement.error,
        metadata: settlement.metadata,
      })
    } catch (error) {
      // 用户拒绝授权：不做成工具错误结果，而是让整个回合停止
      if (error instanceof PermissionDeclinedError) {
        await appendToolSettlement(handle, session.id, {
          callID: params.callID,
          status: "error",
          error: error.message,
          metadata: { effect: "state", failureKind: "permission" },
        })
        await updateTaskFromTool(handle, {
          callID: params.callID,
          name: params.name,
          input: params.input,
          status: "error",
          error: error.message,
          metadata: { effect: "state", failureKind: "permission" },
        })
        params.onDeclined(error.message)
        return
      }

      logger.error("工具结算过程抛出异常", { sessionID: session.id, callID: params.callID, error })
      await appendToolSettlement(handle, session.id, {
        callID: params.callID,
        status: "error",
        error: `工具执行失败：${describeError(error)}`,
        metadata: { effect: "state", failureKind: "internal" },
      })
      await updateTaskFromTool(handle, {
        callID: params.callID,
        name: params.name,
        input: params.input,
        status: "error",
        error: `工具执行失败：${describeError(error)}`,
        metadata: { effect: "state", failureKind: "internal" },
      })
    }
  }

  const updateTaskFromTool = async (
    handle: SessionHandle,
    input: {
      callID: string
      name: string
      input: unknown
      status: "success" | "error"
      output?: unknown
      error?: string
      metadata?: ToolMetadata
    },
  ): Promise<void> => {
    const task = handle.state.task
    if (!task || task.outcome) return

    const metadata = input.metadata
    const changedPaths = unique([
      ...task.changedPaths,
      ...(metadata?.changedPaths ?? []),
    ])
    const signature = `${input.name}:${stableStringify(input.input)}`
    const observation = summarizeToolResult(input.status, input.output, input.error)
    const repeated =
      task.lastToolSignature === signature && task.lastObservation === observation
        ? task.repeatedToolCalls + 1
        : 0

    const mutation =
      input.status === "success" &&
      (metadata?.effect === "mutation" || (metadata?.changedPaths?.length ?? 0) > 0)
    const phase = metadata?.needsInput
      ? "clarify"
      : mutation
        ? "execute"
        : input.name === "todowrite"
          ? "plan"
          : metadata?.verification
            ? metadata.verification.status === "failed"
              ? "verify"
              : "finalize"
            : task.phase
    let next: TaskState = {
      ...task,
      changedPaths,
      verificationStatus: mutation ? "stale" : task.verificationStatus,
      phase,
      toolCalls: task.toolCalls + 1,
      repeatedToolCalls: repeated,
      mutationRevision: mutation ? task.mutationRevision + 1 : task.mutationRevision,
      lastToolSignature: signature,
      lastObservation: observation,
    }

    if (metadata?.verification) {
      next = recordVerification(next, {
        status: metadata.verification.status,
        command: metadata.verification.command,
        summary: metadata.verification.summary,
        callID: input.callID,
        timestamp: Date.now(),
      })
    }
    await appendTask(handle, next)
  }

  /** 把工具结算结果写入事件日志。 */
  const appendToolSettlement = async (
    handle: SessionHandle,
    sessionID: string,
    input: {
      callID: string
      status: "success" | "error"
      /** 结构化结果，供 UI 展示 */
      output?: unknown
      /** 发给模型的内容块（已完成截断），仅成功时存在 */
      content?: Content[]
      /** 完整输出的落盘路径，仅在输出超限时存在 */
      outputPaths?: string[]
      /** 失败说明，仅失败时存在 */
      error?: string
      metadata?: ToolMetadata
    },
  ): Promise<void> => {
    await handle.append({
      type: "tool.settled",
      sessionID,
      timestamp: Date.now(),
      callID: input.callID,
      status: input.status,
      ...(input.output === undefined ? {} : { output: input.output }),
      ...(input.content === undefined ? {} : { content: input.content }),
      ...(input.outputPaths === undefined ? {} : { outputPaths: input.outputPaths }),
      ...(input.error === undefined ? {} : { error: input.error }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    })
  }

  /**
   * 给仍然处于 pending 的工具调用补一条失败结果。
   *
   * 走到这里说明有工具的结算任务没有把自己写进日志（例如进程被强杀之后重启）。
   * 不补的话，下一次请求里就会出现「有 tool_call 但没有对应 tool 消息」的非法历史。
   */
  const settlePendingTools = async (handle: SessionHandle, sessionID: string, messageID: string): Promise<void> => {
    const message = handle.state.messageIndex.get(messageID)
    if (!message || message.role !== "assistant") return

    for (const part of message.parts) {
      if (part.type !== "tool" || part.state.status !== "pending") continue
      await appendToolSettlement(handle, sessionID, {
        callID: part.callID,
        status: "error",
        error: "该工具调用没有返回结果（可能被中断）",
        metadata: { failureKind: "aborted" },
      })
    }
  }

  /* ------------------------------------------------------------------------ */
  /* 输入提升                                                                  */
  /* ------------------------------------------------------------------------ */

  /**
   * 把待处理输入提升为模型可见的用户消息。
   *
   * `steer` 提升全部插话；`queue` 只提升一条排队输入，同时把插话一并提升。
   * 返回提升的条数，调用方据此决定是否重置步数预算。
   */
  const promoteInputs = async (
    handle: SessionHandle,
    delivery: Delivery | undefined,
  ): Promise<{ count: number; texts: string[] }> => {
    if (delivery === undefined) return { count: 0, texts: [] }

    const pending = pendingInputList(handle.state)
    if (pending.length === 0) return { count: 0, texts: [] }

    const selected =
      delivery === "steer"
        ? pending.filter((item) => item.delivery === "steer")
        : [
            ...pending.filter((item) => item.delivery === "queue").slice(0, 1),
            ...pending.filter((item) => item.delivery === "steer"),
          ]

    const texts: string[] = []
    for (const item of selected) {
      const messageID = newMessageID()
      await handle.append({
        type: "input.promoted",
        sessionID: handle.id,
        timestamp: Date.now(),
        inputID: item.inputID,
        messageID,
      })
      texts.push(item.text)
      await updateTitleFromFirstInput(handle, item.text)
    }

    if (texts.length > 0) logger.info("已提升用户输入", { sessionID: handle.id, count: texts.length, delivery })
    return { count: texts.length, texts }
  }

  const appendTask = async (handle: SessionHandle, task: TaskState): Promise<void> => {
    await handle.append({
      type: "task.updated",
      sessionID: handle.id,
      timestamp: Date.now(),
      task,
    })
  }

  const ensureTask = async (handle: SessionHandle, inputs: string[]): Promise<void> => {
    if (inputs.length === 0) return

    const current = handle.state.task
    if (!current || current.outcome) {
      const first = inputs[0]
      if (first === undefined) return
      await appendTask(handle, createTaskState(first, Date.now()))
      return
    }

    let amended = current
    for (const input of inputs) amended = amendTask(amended, input)
    await appendTask(handle, amended)
  }

  const finalizeTask = async (handle: SessionHandle, interrupted: boolean): Promise<void> => {
    const task = handle.state.task
    if (!task || task.outcome) return

    const summary = latestAssistantText(handle.state) || "本轮已结束，没有生成可总结的回复。"
    let status: TaskOutcomeStatus = "success"
    const remaining: string[] = []

    if (interrupted) status = "cancelled"
    else if (task.phase === "blocked") status = "blocked"
    else if (task.verificationStatus === "stale" || task.verificationStatus === "failed") {
      status = "partial"
      remaining.push(
        task.verificationStatus === "failed" ? "相关验证仍然失败。" : "修改尚未经过验证。",
      )
    }

    await appendTask(
      handle,
      finishTask(task, {
        status,
        summary: truncate(summary, 800),
        remaining,
        timestamp: Date.now(),
      }),
    )
  }

  /** 首次输入到达时，用它的开头作为会话标题。避免额外调用模型生成标题。 */
  const updateTitleFromFirstInput = async (handle: SessionHandle, text: string): Promise<void> => {
    if (handle.state.session.title !== DEFAULT_SESSION_TITLE) return
    const title = text.replace(/\s+/g, " ").trim().slice(0, 30)
    if (title.length === 0) return
    await handle.append({
      type: "session.updated",
      sessionID: handle.id,
      timestamp: Date.now(),
      title: title.length < text.length ? `${title}…` : title,
    })
  }

  return { wake, interrupt, isRunning: (sessionID) => controls.get(sessionID)?.running === true, shutdown }
}

/** 判断会话里是否存在指定投递方式的待处理输入。 */
const hasPendingInput = (state: ProjectedState, delivery: Delivery): boolean =>
  [...state.pendingInputs.values()].some((input) => input.delivery === delivery)

const latestAssistantText = (state: ProjectedState): string | undefined => {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index]
    if (!message || message.role !== "assistant") continue
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim()
    if (text.length > 0) return text
  }
  return undefined
}

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`

const unique = (values: string[]): string[] => [...new Set(values)]

const stableStringify = (value: unknown): string => {
  if (value === undefined) return "undefined"
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`

  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`
}

const summarizeToolResult = (status: "success" | "error", output: unknown, error: string | undefined): string => {
  if (error !== undefined) return truncate(error.replace(/\s+/g, " ").trim(), 300)
  if (output === undefined) return status
  try {
    return truncate(JSON.stringify(output), 300)
  } catch {
    return status
  }
}

/**
 * 为一个 provider turn 派生取消控制器。
 *
 * 它同时受两个信号驱动：
 * - 外层回合被中断（用户点了「停止」）
 * - 本轮被主动取消（用户拒绝了某次授权）
 *
 * 之所以不直接复用外层信号，是因为这两种情况对用户的意义完全不同：
 * 中断意味着「整个回合停下」，而拒绝只应该取消本轮剩下的工具调用。
 * 用同一个信号会让两种状态互相污染，最终连结束原因都标错。
 *
 * 返回的 `dispose` 必须在回合结束时调用。AbortSignal 会强引用监听器，
 * 不解绑的话一个 30 步的回合会在外层信号上留下 30 个失效的监听器。
 */
const createTurnController = (parent: AbortSignal): { controller: AbortController; dispose: () => void } => {
  const controller = new AbortController()

  // 外层已经中止（例如用户在回合启动的瞬间点了停止）：直接继承，无需再监听
  if (parent.aborted) {
    controller.abort(parent.reason)
    return { controller, dispose: () => undefined }
  }

  const onAbort = (): void => controller.abort(parent.reason)
  parent.addEventListener("abort", onAbort)
  return { controller, dispose: () => parent.removeEventListener("abort", onAbort) }
}

/** 把任意异常归一成可读的失败对象，同时把「被中断」识别出来。 */
const normalizeFailure = (error: unknown, signal: AbortSignal): unknown => {
  if (signal.aborted && !(error instanceof LLMError && error.kind === "context_overflow")) {
    return new LLMError("aborted", "回合已被中断", { cause: error })
  }
  return error
}

const isAbortLike = (error: unknown): boolean =>
  isAbortError(error) || (error instanceof LLMError && error.kind === "aborted")
