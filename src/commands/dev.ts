import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { CliUsageError, defineCommand, withHandler } from "../cli/command.ts";
import { optPath } from "../cli/options.ts";
import { isRecord, isStringArray } from "../lib/guards.ts";
import { exec } from "../lib/shell.ts";

/** Native projects can declare a dev runner without a Compose stack. No shell expansion. */
export async function loadDevCommand({ cwd }: { readonly cwd: string }) {
  let start: string;
  try {
    start = await realpath(cwd);
  } catch {
    throw new CliUsageError(
      "Cannot find the selected dev directory. Check --path."
    );
  }
  const boundary = await trustedGitBoundary(start);
  let root = start;
  while (!(await Bun.file(resolve(root, ".hack/dev.json")).exists())) {
    if (root === boundary) {
      throw new CliUsageError(
        "No .hack/dev.json found in this repository. Declare a side-by-side dev command first."
      );
    }
    root = dirname(root);
  }
  const configPath = await realpath(resolve(root, ".hack/dev.json"));
  const uid = process.getuid?.();
  if (uid !== undefined && (await stat(configPath)).uid !== uid) {
    throw new CliUsageError(
      "The dev declaration must be owned by the current user."
    );
  }
  const configRelative = relative(boundary, configPath);
  if (
    isAbsolute(configRelative) ||
    configRelative === ".." ||
    configRelative.startsWith(`..${sep}`)
  ) {
    throw new CliUsageError(
      "The dev declaration must stay inside this repository."
    );
  }
  let declaration: unknown;
  try {
    declaration = await Bun.file(configPath).json();
  } catch {
    throw new CliUsageError("Cannot read .hack/dev.json: expected valid JSON.");
  }
  if (
    !isRecord(declaration) ||
    declaration.version !== 1 ||
    !isStringArray(declaration.command) ||
    declaration.command.length === 0 ||
    !declaration.command[0] ||
    declaration.command.some((arg) => arg.includes("\0"))
  ) {
    throw new CliUsageError(
      "Invalid .hack/dev.json: expected version 1 and a nonempty command array."
    );
  }
  return { root, command: declaration.command };
}

/** A marker alone is insufficient in shared ancestors; ask Git and check ownership. */
async function trustedGitBoundary(start: string): Promise<string> {
  try {
    const result = await exec(
      [
        "git",
        "-C",
        start,
        "-c",
        "core.fsmonitor=false",
        "rev-parse",
        "--show-toplevel",
      ],
      { timeoutMs: 3000, stdin: "ignore" }
    );
    if (result.exitCode !== 0) {
      return start;
    }
    const root = await realpath(result.stdout.trim());
    const fromRoot = relative(root, start);
    if (
      isAbsolute(fromRoot) ||
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`)
    ) {
      return start;
    }
    const uid = process.getuid?.();
    return uid === undefined || (await stat(root)).uid === uid ? root : start;
  } catch {
    return start;
  }
}

export const devCommand = withHandler(
  defineCommand({
    name: "dev",
    summary: "Run the project's side-by-side development build",
    description:
      "Runs the command array in .hack/dev.json from its repository root. The runner owns isolation, reload and cleanup. Ctrl-C stops the foreground runner.",
    group: "Project",
    options: [optPath],
    positionals: [],
    subcommands: [],
  } as const),
  async ({ ctx, args }) => {
    const { root, command } = await loadDevCommand({
      cwd: resolve(ctx.cwd, args.options.path ?? "."),
    });
    let child: ReturnType<typeof Bun.spawn>;
    try {
      child = Bun.spawn(command, {
        cwd: root,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
    } catch {
      throw new CliUsageError(
        "Cannot start the declared dev command. Check its executable and working directory."
      );
    }
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    const hangup = () => child.kill("SIGHUP");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    process.on("SIGHUP", hangup);
    try {
      return await child.exited;
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      process.off("SIGHUP", hangup);
    }
  }
);
