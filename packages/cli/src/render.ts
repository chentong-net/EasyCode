import { createInterface } from "node:readline"

import type { Core, Logger } from "@easycode/core"
import type { Event } from "@easycode/schema"

/**
 * 把会话事件渲染到终端。
 *
 * 这是「Core 不依赖界面」这条约束最直接的证据：渲染层只消费事件流，
 * 通过公开的会话接口回写输入，不触碰任何内部状态。
 * 换成一个 React 界面时，被替换的只有这个文件。
 *
 * 两个必须处理的细节：
 * 1. **文本增量与权威值会重复**。流式增量用于实时显示，落盘的 part 是权威值。
 *    两者都可能到达，因此按 part 记录已打印的字符数，只补打差额。
 * 2. **审批请求不回应就会一直挂着**。命令行没有别的交互通道，
 *    必须在这里询问用户，否则工具会永久等待。
 */

/** 单次展示的工具入参长度上限，避免一条 grep 命令把终端刷满。 */
const TOOL_INPUT_PREVIEW_LIMIT = 200

export interface TerminalIO {
  write(text: string): void
  ask(question: string): Promise<string>
  close(): void
}

export const createTerminalIO = (): TerminalIO => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return {
    write: (text) => {
      process.stdout.write(text)
    },
    ask: (question) =>
      new Promise<string>((resolve) => {
        rl.question(question, (answer) => resolve(answer))
      }),
    close: () => rl.close(),
  }
}

export interface SessionRendererOptions {
  core: Core
  io: TerminalIO
  sessionID: string
  /** 是否展示模型的推理过程。默认关闭，因为它通常比结论长得多。 */
  showReasoning?: boolean
  logger: Logger
}

export interface SessionRenderer {
  /** 开始渲染。返回取消订阅函数。 */
  start(): () => void
}

export const createSessionRenderer = (options: SessionRendererOptions): SessionRenderer => {
  const { core, io, sessionID, logger } = options
  const showReasoning = options.showReasoning === true

  /** 是否处于行首。工具调用与状态行前面需要先补一个换行。 */
  let atLineStart = true
  /** part 键 → 已打印的字符数。用于在权威值到达时只补打差额。 */
  const printedChars = new Map<string, number>()
  /** part 键 → 是否已经输出过前缀（推理与正文各有一个前缀）。 */
  const startedParts = new Set<string>()
  /** 工具调用 ID → 工具名。工具完成事件里不带名字，需要回查。 */
  const toolNames = new Map<string, string>()
  /** 审批询问串行化：同一时刻只问一个问题，避免多个请求的输出交错在一起。 */
  let askQueue: Promise<void> = Promise.resolve()

  const write = (text: string): void => {
    if (text.length === 0) return
    io.write(text)
    atLineStart = text.endsWith("\n")
  }

  /** 需要另起一行时补一个换行。避免状态行接在流式文本的中间。 */
  const ensureNewline = (): void => {
    if (atLineStart) return
    write("\n")
  }

  const partKey = (messageID: string, index: number): string => `${messageID}:${index}`

  /** 打印 part 文本，跳过已经通过流式增量打印过的部分。 */
  const printPart = (key: string, text: string, prefix: string): void => {
    const shown = printedChars.get(key) ?? 0
    if (text.length <= shown) return

    if (!startedParts.has(key)) {
      startedParts.add(key)
      ensureNewline()
      write(prefix)
    }

    // 已经开过头的情况下直接续写，不能补换行：那会把一句话从中间截断
    write(text.slice(shown))
    printedChars.set(key, text.length)
  }

  const handlePermission = (event: Extract<Event, { type: "permission.asked" }>): void => {
    ensureNewline()
    write(
      [
        `\n需要授权：${event.action}`,
        `\n  资源：${event.resources.join("、")}`,
        `\n  请选择：y=仅本次 / a=总是允许 / n=拒绝\n`,
      ].join(""),
    )

    askQueue = askQueue
      .then(async () => {
        const answer = (await io.ask("> ")).trim().toLowerCase()
        const reply = answer === "a" ? "always" : answer === "y" || answer === "yes" ? "once" : "reject"

        const handle = await core.sessions.handle(sessionID)
        await core.permissions.reply({
          handle,
          requestID: event.requestID,
          reply,
          ...(reply === "reject" ? { feedback: "用户在命令行中拒绝了该操作" } : {}),
        })
        logger.info("已在命令行中回应审批", { sessionID, requestID: event.requestID, reply })
      })
      .catch((error) => {
        // 回合可能已经被中断，此时审批请求早已失效，回复会失败。
        // 这不是错误，只是说明用户的输入来得太晚了。
        logger.warn("回应审批失败", { sessionID, requestID: event.requestID, error })
      })
  }

  const handleEvent = (event: Event): void => {
    switch (event.type) {
      case "text.delta": {
        const key = partKey(event.messageID, event.index)
        if (!startedParts.has(key)) {
          startedParts.add(key)
          ensureNewline()
        }
        write(event.text)
        printedChars.set(key, (printedChars.get(key) ?? 0) + event.text.length)
        break
      }

      case "part.text":
        printPart(partKey(event.messageID, event.index), event.text, "")
        break

      case "reasoning.delta": {
        if (!showReasoning) break
        const key = partKey(event.messageID, event.index)
        if (!startedParts.has(key)) {
          startedParts.add(key)
          ensureNewline()
          write("· ")
        }
        write(event.text)
        printedChars.set(key, (printedChars.get(key) ?? 0) + event.text.length)
        break
      }

      case "part.reasoning":
        if (!showReasoning) break
        printPart(partKey(event.messageID, event.index), event.text, "· ")
        break

      case "tool.called": {
        toolNames.set(event.callID, event.name)
        ensureNewline()
        write(`\n→ ${event.name} ${preview(event.input)}\n`)
        break
      }

      case "tool.settled": {
        const name = toolNames.get(event.callID) ?? "工具"
        ensureNewline()
        if (event.status === "success") {
          write(`  ✓ ${name}\n`)
        } else {
          write(`  ✗ ${name}：${event.error ?? "执行失败"}\n`)
        }
        break
      }

      case "permission.asked":
        handlePermission(event)
        break

      case "message.ended":
        if (event.error !== undefined) {
          ensureNewline()
          write(`\n本轮结束（${event.finish}）：${event.error}\n`)
        }
        break

      case "compaction.ended":
        ensureNewline()
        write(`\n[已执行 compaction（压缩），保留最近 ${event.recentMessageIDs.length} 条消息]\n`)
        break

      case "run.interrupted":
        ensureNewline()
        write("\n[回合已被中断]\n")
        break

      // 其余事件不影响终端展示
      case "session.created":
      case "session.updated":
      case "session.failed":
      case "session.todos":
      case "input.admitted":
      case "input.promoted":
      case "message.started":
      case "tool.input.delta":
      case "context.updated":
      case "permission.replied":
      case "run.started":
      case "run.idle":
        break
    }
  }

  return {
    start: () => {
      const unsubscribe = core.hub.subscribe(sessionID, handleEvent)
      logger.debug("终端渲染器已附加", { sessionID })
      return () => {
        unsubscribe()
        logger.debug("终端渲染器已分离", { sessionID })
      }
    },
  }
}

/** 把工具入参压成一行短预览。 */
const preview = (input: unknown): string => {
  if (input === undefined || input === null) return ""
  let text: string
  try {
    text = typeof input === "string" ? input : JSON.stringify(input)
  } catch {
    return "(入参无法序列化)"
  }
  const flattened = text.replace(/\s+/g, " ")
  return flattened.length <= TOOL_INPUT_PREVIEW_LIMIT
    ? flattened
    : `${flattened.slice(0, TOOL_INPUT_PREVIEW_LIMIT)}…`
}
