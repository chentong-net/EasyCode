/**
 * SSE（Server-Sent Events）解析。
 *
 * 只做一件事：把字节流切成一个个 data 载荷字符串。
 * 不做 JSON 解析、不理解语义，那是 protocol.ts 的职责。
 */

/**
 * 从 SSE 响应体中依次读出 data 载荷。
 *
 * 处理三个容易出错的细节：
 * 1. 分片边界：一个 UTF-8 字符或一个事件块可能被 TCP 分片切断，
 *    因此 TextDecoder 必须开 stream 模式，剩余不完整的内容留在缓冲区等下一个分片。
 * 2. 换行符：协议允许 \r\n，统一归一成 \n 之后只需按空行切分。
 * 3. 提前退出：消费方 break（例如用户点了中断）时，必须取消底层读取，
 *    否则连接会一直挂着。
 */
export async function* readServerSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder("utf-8")
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")

      let boundary = buffer.indexOf("\n\n")
      while (boundary !== -1) {
        const payload = extractData(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        if (payload !== undefined) yield payload
        boundary = buffer.indexOf("\n\n")
      }
    }

    // 流已结束但缓冲区还有内容：说明最后一块没有以空行收尾
    const tail = extractData(buffer.replace(/\r\n/g, "\n"))
    if (tail !== undefined) yield tail
  } finally {
    // 正常读完时 cancel 是无害的；提前 break 时它负责释放连接
    await reader.cancel().catch(() => undefined)
  }
}

/**
 * 从一个事件块中取出 data 载荷。
 *
 * 一个事件块可以有多行 data，按协议应当用换行拼接。OpenAI 始终只用一行，
 * 但把多行情况处理掉可以让解析器对兼容实现更宽容。
 * 注释行（以 `:` 开头，用于心跳）会被自然忽略。
 */
const extractData = (block: string): string | undefined => {
  const dataLines = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())

  if (dataLines.length === 0) return undefined
  return dataLines.join("\n")
}
