import { mkdir, stat } from "node:fs/promises";

export async function pathExists(absolutePath: string): Promise<boolean> {
  try {
    const file = Bun.file(absolutePath);
    if (typeof file.stat === "function") {
      await file.stat();
      return true;
    }
    await stat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(absoluteDir: string): Promise<void> {
  await mkdir(absoluteDir, { recursive: true });
}

export async function readTextFile(
  absolutePath: string
): Promise<string | null> {
  try {
    return await Bun.file(absolutePath).text();
  } catch {
    return null;
  }
}

export async function writeTextFile(
  absolutePath: string,
  content: string
): Promise<void> {
  await Bun.write(absolutePath, content);
}

export async function writeTextFileIfChanged(
  absolutePath: string,
  content: string
): Promise<{ readonly changed: boolean }> {
  const existing = await readTextFile(absolutePath);
  if (existing === content) {
    return { changed: false };
  }
  await writeTextFile(absolutePath, content);
  return { changed: true };
}

/**
 * Ensures a marker-delimited managed block exists in a gitignore-style file.
 *
 * Merge scheme (simple + robust):
 * - File missing: write just the managed block.
 * - Both markers present: replace the lines between them with the canonical
 *   entries; everything before/after the block (user additions) is preserved.
 * - Begin marker present but end marker missing (corrupted block): replace
 *   from the begin marker to end-of-file with a fresh block.
 * - No markers: preserve the existing content and append the managed block.
 *
 * Idempotent: rewrites only when the resulting content differs.
 * @returns Whether the file was modified
 */
export async function ensureManagedGitignoreBlock(opts: {
  readonly gitignorePath: string;
  readonly beginMarker: string;
  readonly endMarker: string;
  readonly entries: readonly string[];
}): Promise<{ readonly changed: boolean }> {
  const block = [opts.beginMarker, ...opts.entries, opts.endMarker].join("\n");
  const existing = await readTextFile(opts.gitignorePath);
  if (existing === null) {
    return await writeTextFileIfChanged(opts.gitignorePath, `${block}\n`);
  }

  const lines = existing.split("\n");
  const beginIndex = lines.findIndex(
    (line) => line.trim() === opts.beginMarker
  );
  if (beginIndex !== -1) {
    const endOffset = lines
      .slice(beginIndex + 1)
      .findIndex((line) => line.trim() === opts.endMarker);
    const tail =
      endOffset === -1 ? [] : lines.slice(beginIndex + 1 + endOffset + 1);
    const next = [...lines.slice(0, beginIndex), block, ...tail].join("\n");
    const withNewline = next.endsWith("\n") ? next : `${next}\n`;
    return await writeTextFileIfChanged(opts.gitignorePath, withNewline);
  }

  const base = existing.endsWith("\n") ? existing : `${existing}\n`;
  const separator = existing.trim().length > 0 ? "\n" : "";
  return await writeTextFileIfChanged(
    opts.gitignorePath,
    `${base}${separator}${block}\n`
  );
}

/**
 * Ensures an entry exists in .gitignore. Creates the file if it doesn't exist.
 * @returns Whether the file was modified
 */
export async function ensureGitignoreEntry(opts: {
  readonly gitignorePath: string;
  readonly entry: string;
  readonly comment?: string;
}): Promise<{ readonly changed: boolean }> {
  const existing = await readTextFile(opts.gitignorePath);
  const entryLine = opts.entry.trim();

  if (existing !== null) {
    const lines = existing.split("\n");
    const hasEntry = lines.some((line) => line.trim() === entryLine);
    if (hasEntry) {
      return { changed: false };
    }

    const newContent = existing.endsWith("\n") ? existing : `${existing}\n`;
    const addition = opts.comment
      ? `\n${opts.comment}\n${entryLine}\n`
      : `\n${entryLine}\n`;
    await writeTextFile(opts.gitignorePath, newContent + addition);
    return { changed: true };
  }

  const content = opts.comment
    ? `${opts.comment}\n${entryLine}\n`
    : `${entryLine}\n`;
  await writeTextFile(opts.gitignorePath, content);
  return { changed: true };
}
