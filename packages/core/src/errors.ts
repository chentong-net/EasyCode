/**
 * Core 内部使用的错误类型。
 *
 * 这里刻意区分「工具失败」和「用户拒绝」两类：它们的处理路径完全不同。
 */

/**
 * 工具执行失败。
 *
 * 会被转换成一条工具错误结果返回给模型，模型可以据此调整策略
 * （例如换个路径、改用别的命令）。绝大多数工具错误都属于这一类。
 */
export class ToolFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ToolFailure"
  }
}

/**
 * 用户拒绝了授权请求，或回合被中断导致审批无法继续。
 *
 * 与工具失败的区别在于：它会让**整个回合停止**，而不是把拒绝原因交给模型。
 * 理由是用户已经明确表达了「不要做这件事」，让模型绕个弯继续尝试是危险的；
 * 停下来让用户重新发指令，行为更可预期。
 */
export class PermissionDeclinedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PermissionDeclinedError"
  }
}

/** 回合被中断。用于把中断与普通失败区分开，避免被当成错误上报。 */
export class RunInterruptedError extends Error {
  constructor(message = "回合已被中断") {
    super(message)
    this.name = "RunInterruptedError"
  }
}

/** 判断一个错误是否为「中止」类异常（AbortController 触发时原生抛出的形态）。 */
export const isAbortLikeError = (error: unknown): boolean =>
  error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
