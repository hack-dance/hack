type ClipboardResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

type ClipboardCommand = {
  readonly command: string
  readonly args: readonly string[]
  readonly label: string
  readonly platforms?: readonly NodeJS.Platform[]
}

const CLIPBOARD_COMMANDS: readonly ClipboardCommand[] = [
  { command: "pbcopy", args: [], label: "pbcopy", platforms: ["darwin"] },
  { command: "wl-copy", args: [], label: "wl-copy", platforms: ["linux"] },
  { command: "xclip", args: ["-selection", "clipboard"], label: "xclip", platforms: ["linux"] },
  { command: "xsel", args: ["--clipboard", "--input"], label: "xsel", platforms: ["linux"] },
  { command: "cmd.exe", args: ["/c", "clip"], label: "clip", platforms: ["win32"] }
]

export async function copyToClipboard(opts: { readonly text: string }): Promise<ClipboardResult> {
  const command = resolveClipboardCommand()
  if (!command) {
    return {
      ok: false,
      error: "Clipboard helper not found. Install pbcopy/wl-copy/xclip, or use the copy shortcut in your terminal."
    }
  }

  const proc = Bun.spawn([command.command, ...command.args], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "pipe"
  })

  if (!proc.stdin) {
    return { ok: false, error: `Clipboard helper (${command.label}) unavailable.` }
  }

  proc.stdin.write(opts.text)
  proc.stdin.end()

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    return {
      ok: false,
      error: stderr.trim() || `Clipboard helper (${command.label}) failed.`
    }
  }

  return { ok: true }
}

function resolveClipboardCommand(): ClipboardCommand | null {
  const path = (process.env.PATH ?? "").trim()
  if (path.length === 0) return null
  const platform = process.platform
  for (const candidate of CLIPBOARD_COMMANDS) {
    if (candidate.platforms && !candidate.platforms.includes(platform)) continue
    if (Bun.which(candidate.command)) return candidate
  }
  return null
}
