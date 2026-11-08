import { z } from "zod"

/** 问题的发起来源。工具调用与 Runner 检查点共用同一套回答链路。 */
export const QuestionSource = z.enum(["tool", "checkpoint"])

export type QuestionSource = z.infer<typeof QuestionSource>

export const QuestionOption = z.object({
  label: z.string(),
  description: z.string().optional(),
})

export type QuestionOption = z.infer<typeof QuestionOption>

/** 一个等待用户回答的问题。`id` 用于把批量回答稳定地映射回问题。 */
export const QuestionPrompt = z.object({
  id: z.string(),
  header: z.string(),
  question: z.string(),
  options: z.array(QuestionOption).min(1),
  multiple: z.boolean().optional(),
})

export type QuestionPrompt = z.infer<typeof QuestionPrompt>

/** 用户对一个问题的回答。自由输入通过 `custom` 返回，而不是替换问题标识。 */
export const QuestionAnswer = z.object({
  questionID: z.string(),
  selected: z.array(z.string()),
  custom: z.string().optional(),
  skipped: z.boolean().optional(),
})

export type QuestionAnswer = z.infer<typeof QuestionAnswer>

/** 一个已经持久化、正在等待用户回答的请求。 */
export const QuestionRequest = z.object({
  id: z.string(),
  sessionID: z.string(),
  source: QuestionSource,
  title: z.string(),
  callID: z.string().optional(),
  questions: z.array(QuestionPrompt).min(1),
  createdAt: z.number(),
})

export type QuestionRequest = z.infer<typeof QuestionRequest>
