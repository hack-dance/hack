import { mkdir, stat } from "node:fs/promises"

export async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    const file = Bun.file(absolutePath)
    if (typeof file.stat === "function") {
      await file.stat()
      return true
    }
    await stat(absolutePath)
    return true
  } catch {
    return false
  }
}

export async function ensureDir(absoluteDir: string): Promise<void> {
  await mkdir(absoluteDir, { recursive: true })
}

export async function readTextFile(absolutePath: string): Promise<string | null> {
  try {
    return await Bun.file(absolutePath).text()
  } catch {
    return null
  }
}

export async function writeTextFile(absolutePath: string, content: string): Promise<void> {
  await Bun.write(absolutePath, content)
}

export async function writeTextFileIfChanged(
  absolutePath: string,
  content: string
): Promise<{ readonly changed: boolean }> {
  const existing = await readTextFile(absolutePath)
  if (existing === content) return { changed: false }
  await writeTextFile(absolutePath, content)
  return { changed: true }
}
