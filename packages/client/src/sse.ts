import { Event as EventSchema, type Event as StreamEvent } from "@easycode/schema"

/**
 * SSE 字节流解析。
 *
 * 只用最基本的帧语法：以空行分隔的帧，帧内每行形如 `字段: 值`。
 * 需要额外处理的两件事：
 *
 * 1. **换行归一**。SSE 规范允许 `\r\n`，而 TCP 分片完全可能把 `\r` 和 `\n`
 *    切到两个 chunk 里。因此必须对「拼接后的缓冲」整体归一，而不是逐块处理。
 * 2. **注释行**。服务端用 `: connected` 与 `: ping` 做连接确认和心跳，
 *    这些行必须被忽略，而不是当成解析失败。
 */

/** 解析一个完整的帧。返回 undefined 表示这一帧没有数据（注释或心跳）。 */
const parseFrame = (frame: string, onInvalid?: (raw: string) => void): StreamEvent | undefined => {
  const dataLines: string[] = []

  for (const line of frame.split("\n")) {
    if (line.length === 0) continue
    // 注释行：连接确认与心跳都走这个形式
    if (line.startsWith(":")) continue
    // 只关心 data 行。event 行携带的类型在 JSON 里也有，id / retry 暂不使用。
    if (!line.startsWith("data:")) continue
    dataLines.push(line.slice("data:".length).replace(/^ /, ""))
  }

  if (dataLines.length === 0) return undefined

  const raw = dataLines.join("\n")
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    onInvalid?.(raw)
    return undefined
  }

  // 校验一次而不是直接断言：契约一旦漂移，这里就是最早的报错点。
  // 不校验的话，错误会以「界面上某个字段是 undefined」的形式在很远的地方浮现。
  const parsed = EventSchema.safeParse(payload)
  if (!parsed.success) {
    onInvalid?.(raw)
    return undefined
  }
  return parsed.data
}

export interface ParseStreamOptions {
  /** 收到无法解析的帧时回调，用于日志与排查。 */
  onInvalid?: (raw: string) => void
}

/** 把 SSE 字节流转换成事件序列。调用方提前退出时会自动释放底层连接。 */
export async function* parseEventStream(
  body: ReadableStream<Uint8Array>,
  options: ParseStreamOptions = {},
): AsyncGenerator<StreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, "\n")

      let index = buffer.indexOf("\n\n")
      while (index !== -1) {
        const event = parseFrame(buffer.slice(0, index), options.onInvalid)
        buffer = buffer.slice(index + 2)
        if (event) yield event
        index = buffer.indexOf("\n\n")
      }
    }

    // 流结束时可能还剩一帧没有以空行收尾，补处理一次，避免丢掉最后一个事件
    buffer += decoder.decode()
    const tail = parseFrame(buffer, options.onInvalid)
    if (tail) yield tail
  } finally {
    // 调用方 break 或抛错时都要取消读取，否则连接会一直挂着
    await reader.cancel().catch(() => undefined)
  }
}
