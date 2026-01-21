export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly stdin?: "inherit" | "pipe" | "ignore";
}

export async function exec(
  cmd: readonly string[],
  opts: ExecOptions = {}
): Promise<ExecResult> {
  const proc = Bun.spawn([...cmd], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin ?? "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdoutText = await streamToText(proc.stdout);
  const stderrText = await streamToText(proc.stderr);
  const exitCode = await proc.exited;

  return {
    exitCode,
    stdout: stdoutText,
    stderr: stderrText,
  };
}

export interface RunOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly stdin?: "inherit" | "pipe" | "ignore";
}

export async function run(
  cmd: readonly string[],
  opts: RunOptions = {}
): Promise<number> {
  const proc = Bun.spawn([...cmd], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin ?? "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  return await proc.exited;
}

async function streamToText(
  stream: ReadableStream<Uint8Array> | null
): Promise<string> {
  if (!stream) {
    return "";
  }
  return await new Response(stream).text();
}

export async function findExecutableInPath(
  executableName: string
): Promise<string | null> {
  const resolved = Bun.which(executableName);
  return typeof resolved === "string" ? resolved : null;
}

export class CommandError extends Error {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly cmd: readonly string[];

  constructor(opts: {
    readonly cmd: readonly string[];
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly message?: string;
  }) {
    super(
      opts.message ??
        `Command failed (exit ${opts.exitCode}): ${opts.cmd.join(" ")}`
    );
    this.name = "CommandError";
    this.exitCode = opts.exitCode;
    this.stdout = opts.stdout;
    this.stderr = opts.stderr;
    this.cmd = opts.cmd;
  }
}

export async function execOrThrow(
  cmd: readonly string[],
  opts: ExecOptions = {}
): Promise<ExecResult> {
  const res = await exec(cmd, opts);
  if (res.exitCode !== 0) {
    throw new CommandError({
      cmd,
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
    });
  }
  return res;
}
