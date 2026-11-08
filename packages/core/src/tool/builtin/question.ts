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
  execute: async (input: Input, context) => {
    await context.authorize({ action: "question", resources: ["*"] })
    const prompts = input.questions.map((question, index) => ({
      id: `q${index}`,
      ...question,
    }))
    const answers = await context.askQuestion(prompts)
    const text = prompts
      .map((question, index) => {
        const answer = answers.find((item) => item.questionID === question.id)
        const value =
          answer?.skipped === true
            ? "已跳过"
            : [...(answer?.selected ?? []), ...(answer?.custom ? [answer.custom] : [])].join("、") || "未回答"
        return `${index + 1}. ${question.header}：${value}`
      })
      .join("\n")

    return {
      output: { answers },
      content: [{ type: "text", text: `用户已经回答：\n${text}` }],
      metadata: { effect: "state" },
    }
  },
})

export type { Input }
