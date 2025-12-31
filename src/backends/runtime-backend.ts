import { exec, run } from "../lib/shell.ts"
import { createStructuredLogGrouper } from "../ui/log-group.ts"
import { readLinesFromStream } from "../ui/lines.ts"

export type RuntimeBackendName = "compose"

export interface RuntimeBackend {
  readonly name: RuntimeBackendName
  up(opts: RuntimeUpOptions): Promise<number>
  down(opts: RuntimeDownOptions): Promise<number>
  psJson(opts: RuntimePsOptions): ReturnType<typeof exec>
  ps(opts: RuntimePsOptions): Promise<number>
  run(opts: RuntimeRunOptions): Promise<number>
}

export interface RuntimeBaseOptions {
  readonly composeFiles: readonly string[]
  readonly composeProject?: string | null
  readonly profiles?: readonly string[]
  readonly cwd: string
}

export interface RuntimeUpOptions extends RuntimeBaseOptions {
  readonly detach: boolean
}

export interface RuntimeDownOptions extends RuntimeBaseOptions {}

export interface RuntimePsOptions extends RuntimeBaseOptions {}

export interface RuntimeRunOptions extends RuntimeBaseOptions {
  readonly service: string
  readonly workdir?: string
  readonly cmdArgs: readonly string[]
}

function buildComposeArgs(opts: RuntimeBaseOptions): string[] {
  return [
    "docker",
    "compose",
    ...(opts.composeProject ? ["-p", opts.composeProject] : []),
    ...opts.composeFiles.flatMap(file => ["-f", file] as const),
    ...(opts.profiles ? opts.profiles.flatMap(profile => ["--profile", profile] as const) : [])
  ]
}

export const composeRuntimeBackend: RuntimeBackend = {
  name: "compose",
  async up(opts) {
    const cmd = [...buildComposeArgs(opts), "up", ...(opts.detach ? ["-d"] : [])]
    if (opts.detach) {
      return await run(cmd, { cwd: opts.cwd })
    }

    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe"
    })

    const stdoutGrouper = createStructuredLogGrouper({
      write: text => process.stdout.write(text)
    })
    const stderrGrouper = createStructuredLogGrouper({
      write: text => process.stderr.write(text)
    })

    const stdoutTask = (async () => {
      for await (const line of readLinesFromStream(proc.stdout)) {
        stdoutGrouper.handleLine(line)
      }
    })()

    const stderrTask = (async () => {
      for await (const line of readLinesFromStream(proc.stderr)) {
        stderrGrouper.handleLine(line)
      }
    })()

    const exitCode = await proc.exited
    await Promise.all([stdoutTask, stderrTask])
    stdoutGrouper.flush()
    stderrGrouper.flush()
    return exitCode
  },
  async down(opts) {
    const cmd = [...buildComposeArgs(opts), "down"]
    return await run(cmd, { cwd: opts.cwd })
  },
  async psJson(opts) {
    const cmd = [...buildComposeArgs(opts), "ps", "--format", "json"]
    return await exec(cmd, { cwd: opts.cwd, stdin: "ignore" })
  },
  async ps(opts) {
    const cmd = [...buildComposeArgs(opts), "ps"]
    return await run(cmd, { cwd: opts.cwd })
  },
  async run(opts) {
    const cmd = [
      ...buildComposeArgs(opts),
      "run",
      "--rm",
      ...(opts.workdir && opts.workdir.length > 0 ? ["-w", opts.workdir] : []),
      opts.service,
      ...(opts.cmdArgs.length > 0 ? opts.cmdArgs : [])
    ]
    return await run(cmd, { cwd: opts.cwd, stdin: "inherit" })
  }
}
