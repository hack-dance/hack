import { resolve } from "node:path";
import { CliUsageError, defineCommand, withHandler } from "../cli/command.ts";
import { optPath } from "../cli/options.ts";
import { isRecord, isStringArray } from "../lib/guards.ts";
import { findUpFile } from "../lib/path.ts";

/** Native projects can declare a dev runner without a Compose stack. No shell expansion. */
export async function loadDevCommand({ cwd }: { readonly cwd: string }) {
  const root = await findUpFile(cwd, ".hack/dev.json");
  if (!root) {
    throw new CliUsageError(
      "No .hack/dev.json found. Declare a side-by-side dev command first."
    );
  }
  let declaration: unknown;
  try {
    declaration = await Bun.file(resolve(root, ".hack/dev.json")).json();
  } catch {
    throw new CliUsageError("Cannot read .hack/dev.json: expected valid JSON.");
  }
  if (
    !isRecord(declaration) ||
    declaration.version !== 1 ||
    !isStringArray(declaration.command) ||
    declaration.command.length === 0 ||
    declaration.command.some((arg) => arg.length === 0 || arg.includes("\0"))
  ) {
    throw new CliUsageError(
      "Invalid .hack/dev.json: expected version 1 and a nonempty command array."
    );
  }
  return { root, command: declaration.command };
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
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
      return await child.exited;
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
  }
);
