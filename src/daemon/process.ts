import { readTextFile, writeTextFile } from "../lib/fs.ts";

export async function readDaemonPid({
  pidPath,
}: {
  readonly pidPath: string;
}): Promise<number | null> {
  const text = await readTextFile(pidPath);
  if (!text) return null;
  const value = Number.parseInt(text.trim(), 10);
  return Number.isFinite(value) ? value : null;
}

export async function writeDaemonPid({
  pidPath,
  pid,
}: {
  readonly pidPath: string;
  readonly pid: number;
}): Promise<void> {
  await writeTextFile(pidPath, `${pid}\n`);
}

export async function removeFileIfExists({
  path,
}: {
  readonly path: string;
}): Promise<void> {
  try {
    await Bun.file(path).delete();
  } catch {
    // ignore missing file
  }
}

export function isProcessRunning({ pid }: { readonly pid: number }): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForProcessExit({
  pid,
  timeoutMs,
  pollMs,
}: {
  readonly pid: number;
  readonly timeoutMs: number;
  readonly pollMs: number;
}): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning({ pid })) return true;
    await sleep({ ms: pollMs });
  }
  return !isProcessRunning({ pid });
}

function sleep({ ms }: { readonly ms: number }): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
