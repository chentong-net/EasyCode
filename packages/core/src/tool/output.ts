import type { Content } from "@easycode/schema"

import { createLogger } from "../log.js"

const logger = createLogger("tool.output")

/**
 * 工具输出截断。
 *
 * 这是长会话不炸上下文的唯一防线：任何工具的任何输出，在进入历史之前
 * 都必须经过这里。之所以要在注册中心统一做，而不是让每个工具自己注意，
 * 是因为「某个工具忘记限制输出」的后果是灾难性的——
 * 一次 `cat` 大文件就能把上下文塞满，而错误现场极难复现。
 *
 * 处理策略：先按行数限制，再按字节限制，超出的完整内容落盘，
 * 模型看到的是「头尾各取一部分 + 落盘路径」。保留头尾而不是只留头部，
 * 是因为报错信息、命令的最终结果通常出现在输出末尾。
 */

/** 默认保留的最大行数 */
export const MAX_OUTPUT_LINES = 2_000

/** 默认保留的最大字节数 */
export const MAX_OUTPUT_BYTES = 50 * 1024

export interface BoundedText {
  /** 裁剪之后的文本 */
  text: string
  /** 完整内容的落盘路径；未发生裁剪时为空 */
  path?: string
  /** 是否发生了裁剪 */
  truncated: boolean
}

export interface BoundTextOptions {
  text: string
  /** 完整内容落盘函数 */
  save: (content: string) => Promise<string>
  maxLines?: number
  maxBytes?: number
}

/** 把文本裁剪到限制之内，超出部分落盘。 */
export const boundText = async (options: BoundTextOptions): Promise<BoundedText> => {
  const maxLines = options.maxLines ?? MAX_OUTPUT_LINES
  const maxBytes = options.maxBytes ?? MAX_OUTPUT_BYTES
  const original = options.text

  const withinLines = original.split("\n").length <= maxLines
  const withinBytes = Buffer.byteLength(original, "utf8") <= maxBytes
  if (withinLines && withinBytes) return { text: original, truncated: false }

  const path = await options.save(original)
  const marker = `...（输出过长已截断，完整内容保存在：${path}）`

  const byLines = truncateLines(original, maxLines, marker)
  const text = truncateBytes(byLines, maxBytes, marker)

  logger.info("工具输出已截断", {
    path,
    originalBytes: Buffer.byteLength(original, "utf8"),
    originalLines: original.split("\n").length,
    keptBytes: Buffer.byteLength(text, "utf8"),
  })

  return { text, path, truncated: true }
}

/**
 * 按行数裁剪：头尾各留一半，中间用标记代替。
 *
 * 减 4 行是给标记本身留位置——标记也是输出的一部分，不算的话会略微超出上限。
 */
const truncateLines = (text: string, maxLines: number, marker: string): string => {
  const lines = text.split("\n")
  if (lines.length <= maxLines) return text

  const headLines = Math.ceil(maxLines / 2)
  const tailLines = Math.max(Math.floor(maxLines / 2) - 4, 0)
  return [...lines.slice(0, headLines), marker, ...lines.slice(lines.length - tailLines)].join("\n")
}

/**
 * 按字节裁剪：用于「行数不多但单行极长」的情况（例如压缩后的单行 JSON）。
 *
 * 字符预算不是简单地把字节数当成字符数：中文一个字符占 3 字节，
 * 直接按字节数当字符数会导致裁剪后仍然超限。这里按当前文本的实际
 * 平均字节数换算出字符预算。
 */
const truncateBytes = (text: string, maxBytes: number, marker: string): string => {
  const bytes = Buffer.byteLength(text, "utf8")
  if (bytes <= maxBytes) return text

  const charsPerByte = text.length / bytes
  const charBudget = Math.max(2, Math.floor(maxBytes * charsPerByte))
  const half = Math.floor(charBudget / 2)

  return `${text.slice(0, half)}\n${marker}\n${text.slice(text.length - half)}`
}

export interface BoundedContent {
  /** 裁剪之后的文本内容 */
  text: string
  /** 完整内容落盘路径 */
  paths: string[]
  /** 非文本内容（例如图片），原样保留 */
  files: Content[]
}

/**
 * 裁剪一组内容块。
 *
 * 文本块会被合并成一段再统一裁剪（分开裁剪会让每一段都各自逼近上限，
 * 总量反而失控）；文件块原样保留，因为它们的体积由工具自己控制，
 * 而且 base64 内容被截断之后就彻底没有意义了。
 */
export const boundContent = async (content: Content[], save: (text: string) => Promise<string>): Promise<BoundedContent> => {
  const text = content
    .filter((part): part is Extract<Content, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")

  const files = content.filter((part) => part.type === "file")
  const bounded = await boundText({ text, save })

  return {
    text: bounded.text,
    paths: bounded.path ? [bounded.path] : [],
    files,
  }
}
