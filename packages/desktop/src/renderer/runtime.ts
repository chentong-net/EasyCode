import { useExternalStoreRuntime, type AppendMessage, type AssistantRuntime, type ThreadMessageLike } from "@assistant-ui/react"
import type { Message } from "@easycode/schema"
import { useCallback } from "react"

import type { EasyCodeStore } from "./store"
import { toThreadMessage } from "./thread-message"

/**
 * 把会话状态接到 assistant-ui 上。
 *
 * 用 ExternalStoreRuntime 而不是它内置的运行时，是因为消息的唯一真相来源
 * 在 Core 的事件日志里：界面只是它的一个投影。让 assistant-ui 自己持有消息，
 * 就会出现「界面里的历史」和「事件日志里的历史」两份状态，
 * 一旦不一致（比如重连之后），界面显示的内容就不再是真正发给模型的内容。
 *
 * 这里界面只提供两件事：当前消息列表 + 三个动作（发送、停止、取消）。
 * 其余能力（分支、编辑、重新生成）在 EasyCode 里没有对应语义，因此不注册 ——
 * assistant-ui 是按能力开关的，没注册的入口不会出现。
 */
export const useEasyCodeRuntime = (store: EasyCodeStore): AssistantRuntime => {
  const convertMessage = useCallback((message: Message): ThreadMessageLike => toThreadMessage(message), [])

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = extractText(message)
      if (text.length === 0) return
      await store.send(text)
    },
    [store],
  )

  const onCancel = useCallback(async () => {
    await store.interrupt()
  }, [store])

  return useExternalStoreRuntime({
    messages: store.messages,
    // 直接把 Core 的回合状态交给界面：它比「最后一条消息是否结束」更准确，
    // 在两次 provider turn 之间不会闪回空闲
    isRunning: store.running,
    convertMessage,
    onNew,
    onCancel,
  })
}

/** 从待发送的消息里取出文本。附件目前不支持，因此只处理文本块。 */
const extractText = (message: AppendMessage): string =>
  message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
    .trim()
