import { z } from "zod"

import { defineTool } from "../tool.js"

const questionSchema = z.object({
  header: z.string().describe("问题的简短标题"),
  question: z.string().describe("需要用户回答的问题"),
  options: z
    .array(
      z.object({
        label: z.string(),
        description: z.string().optional(),
      }),
    )
    .min(1)
    .describe("建议答案选项；用户仍然可以自由输入"),
  multiple: z.boolean().optional().describe("是否允许多选"),
})

const inputSchema = z.object({
  questions: z.array(questionSchema).min(1).describe("一次需要用户确认的问题"),
})

type Input = z.infer<typeof inputSchema>

export const questionTool = defineTool({
  name: "question",
  description: [
    "在执行过程中向用户提问，用于确认歧义、取舍或必要约束。",
    "一次可以提出多个问题。问题标题、正文和选项会写入待输入工具结果，用户可在界面查看并自由输入答案。",
    "如果推荐某个选项，请把它放在第一项，并在 label 末尾标注“（推荐）”。",
  ].join("\n"),
  input: inputSchema,
  permission: "question",
  effect: "state",
  resources: () => [],
  savePatterns: () => [],
  execute: async (input: Input) => {
    const text = input.questions
      .map((question, index) => {
        const options = question.options
          .map((option) => `- ${option.label}${option.description ? `：${option.description}` : ""}`)
          .join("\n")
        return [
          `${index + 1}. ${question.header}`,
          question.question,
          options,
          question.multiple === true ? "（可多选，也可以直接输入其他答案）" : "（也可以直接输入其他答案）",
        ].join("\n")
      })
      .join("\n\n")

    return {
      status: "error" as const,
      output: input,
      content: [{ type: "text" as const, text }],
      error: "需要用户回答后继续",
      metadata: { effect: "state" as const, needsInput: true },
    }
  },
})

export type { Input }
