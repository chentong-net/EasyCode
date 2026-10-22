import { z } from "zod"

/**
 * 传输层错误。
 *
 * 用固定的标签而不是自由文本分类，是为了让客户端能做可靠的分支判断：
 * 「会话不存在」和「参数非法」在界面上应该有不同的表现，
 * 靠匹配错误消息文本迟早会因为文案微调而失效。
 */

export const ErrorTag = z.enum([
  /** 请求本身有问题：缺字段、字段类型不对、业务上前置条件不满足 */
  "bad_request",
  /** 目标资源不存在，例如会话 id 无效 */
  "not_found",
  /** 服务端内部错误；当前服务端会把异常的 message 写入响应体，同时记录日志 */
  "internal",
])

export type ErrorTag = z.infer<typeof ErrorTag>

/** 所有非 2xx 响应统一的响应体。 */
export const ErrorBody = z.object({
  error: z.object({
    tag: ErrorTag,
    message: z.string(),
  }),
})

export type ErrorBody = z.infer<typeof ErrorBody>

/** 错误标签到 HTTP 状态码的映射。 */
export const statusForTag = (tag: ErrorTag): number => {
  switch (tag) {
    case "bad_request":
      return 400
    case "not_found":
      return 404
    case "internal":
      return 500
  }
}

/**
 * 客户端抛出的传输层异常。
 *
 * 它同时携带标签与 HTTP 状态码：标签用于程序判断，状态码用于日志与排查。
 * 两条信息都保留是因为它们并不总是一一对应（例如网关返回的 502
 * 会被归类成 internal，但状态码仍然值得记下来）。
 */
export class ProtocolError extends Error {
  readonly tag: ErrorTag
  readonly status: number

  constructor(tag: ErrorTag, message: string, status: number = statusForTag(tag)) {
    super(message)
    this.name = "ProtocolError"
    this.tag = tag
    this.status = status
  }
}
