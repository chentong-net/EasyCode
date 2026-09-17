import type { ServerResponse } from "node:http"

import type { Core, Logger } from "@easycode/core"
import { isDurableEvent, type Event } from "@easycode/schema"

import { commonHeaders } from "./http.js"

/**
 * 会话事件流（SSE）。
 *
 * 这是界面的唯一数据源：文本增量、工具调用、审批请求都从这里推出去。
 * 三个容易踩错的点：
 *
 * 1. **先订阅、再补发**。反过来的话，两次操作之间产生的事件会永久丢失，
 *    表现为「偶尔少一段回复」，而且只在特定时序下复现。
 *    先订阅带来的重复由 seq 去重解决，这个代价是值得付的。
 * 2. **必须发心跳**。空闲连接会被中间的代理或系统静默掐断，
 *    客户端却要等到下一次写数据才知道，于是表现为「过几分钟后突然不更新了」。
 * 3. **必须清理定时器和订阅**。每个断开的连接留下一个定时器，
 *    桌面端开开关关几十次之后就会明显变慢。
 */

/** 心跳间隔。取 15 秒：足够让链路保持活跃，又不会产生明显的空流量。 */
const HEARTBEAT_MS = 15_000

export interface StreamEventsInput {
  core: Core
  sessionID: string
  /** 客户端已收到的最大事件序号；只补发它之后的事件 */
  after: number | undefined
  res: ServerResponse
  logger: Logger
}

export const streamEvents = async (input: StreamEventsInput): Promise<void> => {
  const { core, sessionID, res, logger } = input

  res.writeHead(200, {
    ...commonHeaders(),
    "content-type": "text/event-stream; charset=utf-8",
    // no-transform 是给中间代理看的：不允许它压缩或缓冲响应体，
    // 否则流式推送会被攒成一坨再发，实时性彻底消失
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  })

  // 立刻写一行注释确认连接已建立。SSE 的注释行会被客户端忽略，
  // 但它能让「连接成功」与「服务端还没产出事件」在抓包时区分开。
  res.write(": connected\n\n")

  /** 已经推送出去的最大序号。既用于去重，也用于补发起点。 */
  let lastSeq = input.after ?? 0
  let closed = false

  const write = (event: Event): void => {
    if (closed || res.writableEnded || res.destroyed) return

    // 补发与实时推送会重叠，靠序号去重；流式事件没有 seq，不参与去重
    if (isDurableEvent(event)) {
      if (event.seq <= lastSeq) return
      lastSeq = event.seq
    }

    try {
      // 帧格式：event 行给出事件名方便排查，data 行是完整的 JSON。
      // data 必须是单行，因此 JSON 里的换行由 JSON.stringify 自动转义。
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    } catch (error) {
      logger.warn("推送事件失败，连接可能已断开", { sessionID, type: event.type, error })
    }
  }

  const unsubscribe = core.hub.subscribe(sessionID, write)

  const cleanup = (): void => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
    logger.debug("事件流已关闭", { sessionID, lastSeq })
  }

  const heartbeat = setInterval(() => {
    if (closed || res.writableEnded || res.destroyed) {
      cleanup()
      return
    }
    res.write(`: ping ${Date.now()}\n\n`)
  }, HEARTBEAT_MS)
  // 心跳不应该阻止进程退出：桌面端关闭窗口时若还挂着定时器，
  // sidecar 就会迟迟不结束，用户会看到「应用卡住不退」
  heartbeat.unref()

  res.on("close", cleanup)
  res.on("error", cleanup)

  try {
    const history = await core.store.readEvents(sessionID, lastSeq)
    for (const event of history) write(event)
    logger.debug("事件流已建立", { sessionID, replayed: history.length, after: lastSeq })
  } catch (error) {
    logger.error("补发历史事件失败", { sessionID, error })
    cleanup()
    res.end()
  }
}
