import type { QuestionAnswer, QuestionPrompt, QuestionRequest, QuestionSource } from "@easycode/schema"

import {
  QuestionAnswerInvalidError,
  QuestionCancelledError,
  QuestionRequestNotFoundError,
} from "../errors.js"
import { newQuestionRequestID } from "../id.js"
import type { SessionHandle } from "../session/runtime.js"

export interface AskQuestionInput {
  handle: SessionHandle
  source: QuestionSource
  title: string
  callID?: string
  questions: QuestionPrompt[]
  signal?: AbortSignal
}

export interface ReplyQuestionInput {
  handle: SessionHandle
  requestID: string
  answers: QuestionAnswer[]
}

export interface QuestionService {
  /** 持久化问题并等待用户回答；中断时写入取消事件并抛出 QuestionCancelledError。 */
  ask(input: AskQuestionInput): Promise<QuestionAnswer[]>
  /** 回答一个待处理问题，并唤醒正在等待的调用方。 */
  reply(input: ReplyQuestionInput): Promise<void>
  /** 当前待回答问题，按创建时间正序。 */
  pending(handle: SessionHandle): QuestionRequest[]
}

type Waiter = (answers: QuestionAnswer[]) => void

export const createQuestionService = (): QuestionService => {
  const waiters = new Map<string, Waiter>()

  const ask = async (input: AskQuestionInput): Promise<QuestionAnswer[]> => {
    validateQuestions(input.questions)
    const requestID = newQuestionRequestID()
    await input.handle.append({
      type: "question.asked",
      sessionID: input.handle.id,
      timestamp: Date.now(),
      requestID,
      source: input.source,
      title: input.title,
      ...(input.callID === undefined ? {} : { callID: input.callID }),
      questions: input.questions,
    })

    const outcome = await wait(requestID, input.signal)
    if (outcome === "aborted") {
      await cancelPending(input.handle, requestID, "问题已取消")
      throw new QuestionCancelledError("问题已取消")
    }
    return outcome
  }

  const wait = (
    requestID: string,
    signal: AbortSignal | undefined,
  ): Promise<QuestionAnswer[] | "aborted"> => {
    if (signal?.aborted) return Promise.resolve("aborted")

    return new Promise<QuestionAnswer[] | "aborted">((resolve) => {
      const onAbort = (): void => {
        waiters.delete(requestID)
        resolve("aborted")
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      waiters.set(requestID, (answers) => {
        signal?.removeEventListener("abort", onAbort)
        resolve(answers)
      })
    })
  }

  const reply = async (input: ReplyQuestionInput): Promise<void> => {
    const request = input.handle.state.pendingQuestions.get(input.requestID)
    if (!request) throw new QuestionRequestNotFoundError()
    validateAnswers(request.questions, input.answers)

    await input.handle.append({
      type: "question.replied",
      sessionID: input.handle.id,
      timestamp: Date.now(),
      requestID: input.requestID,
      answers: input.answers,
    })

    const waiter = waiters.get(input.requestID)
    waiters.delete(input.requestID)
    waiter?.(input.answers)
  }

  const pending = (handle: SessionHandle) => pendingQuestions(handle.state.pendingQuestions)

  return { ask, reply, pending }
}

const pendingQuestions = (requests: Map<string, QuestionRequest>): QuestionRequest[] =>
  [...requests.values()].sort((a, b) => a.createdAt - b.createdAt)

const cancelPending = async (handle: SessionHandle, requestID: string, reason: string): Promise<void> => {
  if (!handle.state.pendingQuestions.has(requestID)) return
  await handle.append({
    type: "question.cancelled",
    sessionID: handle.id,
    timestamp: Date.now(),
    requestID,
    reason,
  })
}

const validateQuestions = (questions: QuestionPrompt[]): void => {
  if (questions.length === 0) throw new QuestionAnswerInvalidError("至少需要一个待回答的问题")
  const ids = new Set<string>()
  for (const question of questions) {
    if (question.id.length === 0) throw new QuestionAnswerInvalidError("问题 ID 不能为空")
    if (ids.has(question.id)) throw new QuestionAnswerInvalidError(`问题 ID 重复：${question.id}`)
    ids.add(question.id)
  }
}

const validateAnswers = (questions: QuestionPrompt[], answers: QuestionAnswer[]): void => {
  const expected = new Map(questions.map((question) => [question.id, question]))
  const seen = new Set<string>()

  for (const answer of answers) {
    const question = expected.get(answer.questionID)
    if (!question) throw new QuestionAnswerInvalidError(`未知问题：${answer.questionID}`)
    if (seen.has(answer.questionID)) throw new QuestionAnswerInvalidError(`问题被重复回答：${answer.questionID}`)
    seen.add(answer.questionID)

    if (question.multiple !== true && answer.selected.length > 1) {
      throw new QuestionAnswerInvalidError(`问题只允许单选：${question.header}`)
    }
    const options = new Set(question.options.map((option) => option.label))
    for (const selected of answer.selected) {
      if (!options.has(selected)) {
        throw new QuestionAnswerInvalidError(`选项不属于该问题：${selected}`)
      }
    }
    const custom = answer.custom?.trim()
    if (answer.skipped !== true && answer.selected.length === 0 && !custom) {
      throw new QuestionAnswerInvalidError(`问题尚未回答：${question.header}`)
    }
    if (question.multiple !== true && custom && answer.selected.length > 0) {
      throw new QuestionAnswerInvalidError(`单选题的自由输入不能与其他选项同时提交：${question.header}`)
    }
  }

  const missing = questions.filter((question) => !seen.has(question.id))
  if (missing.length > 0) {
    throw new QuestionAnswerInvalidError(`缺少问题回答：${missing.map((question) => question.header).join("、")}`)
  }
}
