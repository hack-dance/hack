import { resolve } from "node:path";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optJson } from "../cli/options.ts";
import {
  compileNativeConfig,
  NativeConfigCompilerError,
  readNativeConfigInput,
} from "../lib/native-config-compiler.ts";

const spec = defineCommand({
  name: "validate",
  summary:
    "Validate an explicit native project file without starting workloads",
  group: "Project",
  description:
    "Uses the matching bundled Rust compiler. This experimental command does not discover a project, resolve secrets, or adopt native configuration for runtime commands.",
  options: [
    defineOption({
      name: "file",
      type: "string",
      long: "--file",
      valueHint: "<path>",
      description: "Required native project JSON file",
    } as const),
    defineOption({
      name: "profile",
      type: "string",
      long: "--profile",
      valueHint: "<names>",
      description: "Comma-separated declared native profiles",
    } as const),
    optJson,
  ],
  positionals: [],
  subcommands: [],
} as const);

export const configValidateCommand = withHandler(
  spec,
  async ({ ctx, args }) => {
    const file = args.options.file;
    if (!file?.trim()) {
      throw new CliUsageError("Native validation requires --file <path>.");
    }
    const profiles = args.options.profile
      ?.split(",")
      .map((name) => name.trim());
    if (profiles?.some((name) => name.length === 0)) {
      throw new CliUsageError("Native profile names must not be empty.");
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const input = await readNativeConfigInput({
        path: resolve(ctx.cwd, file),
      });
      const result = await compileNativeConfig({
        input,
        profiles,
        signal: controller.signal,
      });
      if (args.options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else if (result.ok) {
        process.stdout.write(
          `Native configuration is valid. Semantic hash: ${result.semantic_hash}\n`
        );
      } else {
        for (const diagnostic of result.diagnostics) {
          process.stderr.write(
            `${diagnostic.code} ${JSON.stringify(diagnostic.pointer || "/")} (${diagnostic.line}:${diagnostic.column}): ${diagnostic.message}\n`
          );
        }
      }
      return result.ok ? 0 : 1;
    } catch (error: unknown) {
      const failure =
        error instanceof NativeConfigCompilerError
          ? error
          : new NativeConfigCompilerError(
              "E_COMPILER_REQUEST",
              "Native configuration validation failed."
            );
      if (args.options.json) {
        process.stdout.write(
          `${JSON.stringify({ transport_version: 1, ok: false, error: { code: failure.code, message: failure.message } })}\n`
        );
      } else {
        process.stderr.write(`${failure.code}: ${failure.message}\n`);
      }
      return 1;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  }
);
