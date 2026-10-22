import type { Event } from "@easycode/schema"

import type { Logger } from "./log.js"

/**
 * 会话事件总线。
 *
 * 只有一个职责：把运行时产生的事件分发给订阅者，例如 SSE 处理器或 CLI 终端渲染器。
 *
 * 设计取舍：用回调而不是 AsyncIterable。
 * HTTP 场景下，SSE 的关闭时机由连接决定；回调式订阅配一个显式的 unsubscribe
 * 函数更容易控制生命周期。
 */
export type EventListener = (event: Event) => void

export interface EventHub {
  /** 订阅某会话的事件，返回取消订阅函数 */
  subscribe(sessionID: string, listener: EventListener): () => void
  /** 发布一条事件 */
  publish(event: Event): void
}

export const createEventHub = (logger: Logger): EventHub => {
  const listeners = new Map<string, Set<EventListener>>()

  const subscribe = (sessionID: string, listener: EventListener): (() => void) => {
    const set = listeners.get(sessionID) ?? new Set<EventListener>()
    set.add(listener)
    listeners.set(sessionID, set)

    return () => {
      const current = listeners.get(sessionID)
      if (!current) return
      current.delete(listener)
      // 没有订阅者时移除整个条目，避免长期运行后 Map 里堆积空集合
      if (current.size === 0) listeners.delete(sessionID)
    }
  }

  const publish = (event: Event): void => {
    const set = listeners.get(event.sessionID)
    if (!set || set.size === 0) return

    for (const listener of set) {
      try {
        listener(event)
      } catch (error) {
        // 单个订阅者出错不能影响其它订阅者，否则一个写失败的 SSE 连接
        // 会把整个会话的事件推送拖垮
        logger.error("事件订阅者处理失败", { sessionID: event.sessionID, type: event.type, error })
      }
    }
  }

  return { subscribe, publish }
}
