import { randomUUID } from "node:crypto"
import { rename, unlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

/** 在同一目录写临时文件后原子替换目标，避免留下截断的源文件。 */
export const writeFileAtomic = async (file: string, content: string | Uint8Array): Promise<void> => {
  const temporary = join(dirname(file), `.${randomUUID()}.easycode.tmp`)
  try {
    await writeFile(temporary, content)
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}
