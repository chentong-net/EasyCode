import type { Message, Part } from "@easycode/schema"
import type { ThreadMessageLike } from "@assistant-ui/react"

/**
 * 领域消息 → assistant-ui 消息。
 *
 * 这是一次**有损转换**，因此转换前要先想清楚哪些信息必须保留：
 * - 工具卡片要展示入参、执行状态与结果，所以工具 part 必须映射成 tool-call part
 * - 推理过程要能折叠展示，所以 reasoning part 原样保留
 * - 本轮失败的原因必须让用户看到，因此错误会被附加成一段文本
 *
 * 至于 system 与 compaction 消息：它们是运行时的内部机制（尤其是压缩检查点），
 * 展示出来只会让用户困惑「这条消息是谁说的」，因此在进入转换之前就被过滤掉了。
 */

/** 去掉字符串形式后，assistant-ui 的内容块联合类型。 */
export type ThreadContent = Exclude<ThreadMessageLike["content"], string>

/** 工具卡片的数据视图。工具的原始结果可能很复杂，先规整成界面需要的形状。 */
export interface ToolResultView {
  ok: boolean
  /** 展示文本（已经过 Core 的截断处理） */
  text: string
  /** 因超出截断阈值而落盘的完整输出路径 */
  outputPaths: string[]
}

type ToolPart = Extract<Part, { type: "tool" }>

const toToolResultView = (part: ToolPart): ToolResultView | undefined => {
  if (part.state.status === "pending") return undefined
  if (part.state.status === "error") {
    return {
      ok: false,
      text:
        part.state.content !== undefined && part.state.content.length > 0
          ? part.state.content
              .map((content) =>
                content.type === "text" ? content.text : `[附件 ${content.name ?? content.mime}]`,
              )
              .join("\n")
          : part.state.error,
      outputPaths: part.state.outputPaths ?? [],
    }
  }
  return {
    ok: true,
    text: part.state.content.map((content) => (content.type === "text" ? content.text : `[附件 ${content.name ?? content.mime}]`)).join("\n"),
    outputPaths: part.state.outputPaths,
  }
}

/** 把一条助手消息的 parts 转成 assistant-ui 的内容块。 */
const assistantContent = (message: Extract<Message, { role: "assistant" }>): ThreadContent => {
  const content: unknown[] = []

  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        content.push({ type: "text", text: part.text })
        break

      case "reasoning":
        content.push({ type: "reasoning", text: part.text })
        break

      case "tool": {
        const view = toToolResultView(part)
        content.push({
          type: "tool-call",
          toolCallId: part.callID,
          toolName: part.name,
          // 入参在 Core 里已经过 zod 校验，这里的 JSON 类型约束只服务于展示层
          args: (part.input ?? {}) as object,
          argsText: safeStringify(part.input),
          ...(view === undefined ? {} : { result: view, isError: !view.ok }),
        })
        break
      }

      case "file":
        // 助手消息里的附件目前不存在，真的出现时再补对应的展示组件
        break
    }
  }

  // 失败原因挂在消息上而不是 part 上，追加成一段文本是最直接的呈现方式：
  // 用户需要知道「这一轮为什么没有结果」，而不是面对一条空消息
  if (message.error !== undefined) {
    content.push({ type: "text", text: `⚠️ ${message.error}` })
  }

  return content as ThreadContent
}

export const toThreadMessage = (message: Message): ThreadMessageLike => {
  if (message.role === "user") {
    return {
      id: message.id,
      role: "user",
      createdAt: new Date(message.createdAt),
      content: message.parts.flatMap((part) =>
        part.type === "text" ? [{ type: "text" as const, text: part.text }] : [],
      ),
    }
  }

  if (message.role !== "assistant") {
    // 调用方已经过滤掉 system / compaction，这里只是兜底
    return { id: message.id, role: "system", content: [] }
  }

  return {
    id: message.id,
    role: "assistant",
    createdAt: new Date(message.createdAt),
    content: assistantContent(message),
    // 未结束的消息标记为 running，运行中的光标与「停止」按钮据此显示
    status:
      message.completedAt === undefined
        ? { type: "running" }
        : { type: "complete", reason: "stop" },
  }
}

const safeStringify = (value: unknown): string => {
  if (value === undefined) return ""
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return "(无法序列化)"
  }
}
