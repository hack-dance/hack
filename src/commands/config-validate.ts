import { resolve } from "node:path";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { resolveRequestedEnvName } from "../cli/env-selection.ts";
import { optEnv, optJson, optPath } from "../cli/options.ts";
import { HackCliError } from "../lib/cli-result.ts";
import {
  NATIVE_GRAPH_ADMISSION_CODE,
  NATIVE_GRAPH_ADMISSION_MESSAGE,
  nativeConsumerAdmitsImages,
} from "../lib/native-authored-image-admission.ts";
import {
  compileNativeConfig,
  type NativeConfigCompileResult,
  NativeConfigCompilerError,
  type NativeConfigResolveResult,
  readNativeConfigInput,
} from "../lib/native-config-compiler.ts";
import { validateNativeProject } from "../lib/native-project-validation.ts";

const spec = defineCommand({
  name: "validate",
  summary:
    "Validate native configuration and selected local overlays without starting workloads",
  group: "Project",
  description:
    "Uses the matching bundled Rust compiler. Without --file, discovers a native project and resolves permitted worktree-local overlay and routing settings. --file validates only the explicit document. With HACK_RUNTIME_BACKEND=native, a selected workload image that is not a sha256: content ID refuses with the native consumer's native_graph_admission code. Neither mode reads env values, writes state, or starts workloads.",
  options: [
    defineOption({
      name: "file",
      type: "string",
      long: "--file",
      valueHint: "<path>",
      description:
        "Validate only this native project JSON file, without discovery or local overrides",
    } as const),
    defineOption({
      name: "profile",
      type: "string",
      long: "--profile",
      valueHint: "<names>",
      description: "Comma-separated declared native profiles",
    } as const),
    defineOption({
      name: "domain",
      type: "string",
      long: "--domain",
      valueHint: "<suffix>",
      description: "Select the generated native routing domain suffix",
    } as const),
    optPath,
    optEnv,
    optJson,
  ],
  positionals: [],
  subcommands: [],
} as const);

export const configValidateCommand = withHandler(
  spec,
  async ({ ctx, args }) => {
    const file = args.options.file;
    if (file !== undefined && !file.trim()) {
      throw new CliUsageError("Native file paths must not be empty.");
    }
    if (
      file !== undefined &&
      (args.options.path !== undefined ||
        args.options.env !== undefined ||
        args.options.domain !== undefined)
    ) {
      throw new CliUsageError(
        "--file validates one document and cannot be combined with --path or --env or --domain."
      );
    }
    const profiles = args.options.profile
      ?.split(",")
      .map((name) => name.trim());
    if (profiles?.some((name) => name.length === 0)) {
      throw new CliUsageError("Native profile names must not be empty.");
    }
    const explicitOverlay = resolveRequestedEnvName({
      envOption: args.options.env,
    });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const result =
        file === undefined
          ? await validateNativeProject({
              startDir: resolve(ctx.cwd, args.options.path ?? "."),
              profiles,
              explicitDomain: args.options.domain,
              explicitOverlay,
              signal: controller.signal,
            })
          : await compileNativeConfig({
              input: await readNativeConfigInput({
                path: resolve(ctx.cwd, file),
              }),
              profiles,
              signal: controller.signal,
            });
      // A tag or repository digest is valid authored configuration for Compose,
      // but the explicitly selected native consumer refuses it at plan and serve.
      if (
        result.ok &&
        process.env.HACK_RUNTIME_BACKEND === "native" &&
        !nativeConsumerAdmitsImages(result.plan)
      ) {
        throw new NativeConfigCompilerError(
          NATIVE_GRAPH_ADMISSION_CODE,
          NATIVE_GRAPH_ADMISSION_MESSAGE
        );
      }
      renderValidationResult({ result, json: args.options.json === true });
      return result.ok ? 0 : 1;
    } catch (error: unknown) {
      const failure =
        error instanceof NativeConfigCompilerError ||
        error instanceof HackCliError
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

function renderValidationResult(opts: {
  readonly result: NativeConfigCompileResult | NativeConfigResolveResult;
  readonly json: boolean;
}): void {
  const result = opts.result;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.ok) {
    process.stdout.write(
      `Native configuration is valid. Semantic hash: ${result.semantic_hash}\n`
    );
    if ("local_resolution" in result) {
      const local = result.local_resolution;
      process.stdout.write(
        `Selected env: ${local.overlay ?? "base"} (${local.origin}). Local resolution hash: ${local.resolution_hash}\n`
      );
    }
    if ("routing_resolution" in result && result.routing_resolution) {
      const routing = result.routing_resolution;
      process.stdout.write(
        `Routing preview: ${routing.open_origin}. Domain: ${routing.domain} (${routing.domain_origin}). DNS and TLS are not checked.\n`
      );
    }
  } else {
    for (const diagnostic of result.diagnostics) {
      process.stderr.write(
        `${diagnostic.document ? `${diagnostic.document} ` : ""}${diagnostic.code} ${JSON.stringify(diagnostic.pointer || "/")} (${diagnostic.line}:${diagnostic.column}): ${diagnostic.message}\n`
      );
    }
  }
}
