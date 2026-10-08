import { resolve } from "node:path";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optEnv, optJson, optPath } from "../cli/options.ts";
import { HackCliError } from "../lib/cli-result.ts";
import {
  NativeConfigCompilerError,
  type NativeConfigDiagnostic,
  type NativeConfigPlanResult,
} from "../lib/native-config-compiler.ts";
import { planNativeProject } from "../lib/native-project-validation.ts";

const spec = defineCommand({
  name: "plan",
  summary:
    "Inspect native environment binding completeness without decrypting or starting workloads",
  group: "Project",
  description:
    "Resolves the native project, permitted local env selection and routing preview, then inspects managed-env names, winning scopes and secret flags. Managed YAML is parsed by its existing owner; keys and values are never decrypted or returned. Required unresolved refs return a nonzero exit. This experimental report does not establish runtime admission or enable native execution; use config validate for validation without managed-document reads.",
  options: [
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

export const configPlanCommand = withHandler(spec, async ({ ctx, args }) => {
  const profiles = args.options.profile?.split(",").map((name) => name.trim());
  if (profiles?.some((name) => name.length === 0)) {
    throw new CliUsageError("Native profile names must not be empty.");
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const result = await planNativeProject({
      startDir: resolve(ctx.cwd, args.options.path ?? "."),
      profiles,
      explicitDomain: args.options.domain,
      explicitOverlay: args.options.env === "base" ? null : args.options.env,
      signal: controller.signal,
    });
    renderPlan({ result, json: args.options.json === true });
    return result.ok &&
      result.environment_plan.complete &&
      result.file_plan?.complete !== false
      ? 0
      : 1;
  } catch (error: unknown) {
    const failure =
      error instanceof NativeConfigCompilerError ||
      error instanceof HackCliError
        ? error
        : new NativeConfigCompilerError(
            "E_COMPILER_REQUEST",
            "Native configuration planning failed; values omitted."
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
});

function renderPlan(opts: {
  readonly result: NativeConfigPlanResult;
  readonly json: boolean;
}): void {
  const result = opts.result;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (!result.ok) {
    for (const diagnostic of result.diagnostics) {
      renderDiagnostic(diagnostic);
    }
    return;
  }
  const envPlan = result.environment_plan;
  if (result.file_plan) {
    process.stdout.write(
      `Native file bindings are ${result.file_plan.complete ? "complete" : "incomplete"}. File material is not read by this report.\n`
    );
  }
  process.stdout.write(
    `Native environment bindings are ${envPlan.complete ? "complete" : "incomplete"}. Semantic hash: ${result.semantic_hash}\n`
  );
  process.stdout.write(
    `Selected env: ${envPlan.overlay ?? "base"} (${result.local_resolution.origin}). This report does not establish runtime admission.\n`
  );
  if (result.routing_resolution) {
    const routing = result.routing_resolution;
    process.stdout.write(
      `Routing preview: ${routing.open_origin}. Domain: ${routing.domain} (${routing.domain_origin}). DNS and TLS are not checked.\n`
    );
  }
  for (const diagnostic of [
    ...envPlan.warnings,
    ...envPlan.diagnostics,
    ...(result.file_plan?.diagnostics ?? []),
  ]) {
    renderDiagnostic(diagnostic);
  }
}

function renderDiagnostic(diagnostic: NativeConfigDiagnostic): void {
  process.stderr.write(
    `${diagnostic.document ?? "project"} ${diagnostic.code} ${JSON.stringify(diagnostic.pointer || "/")} (${diagnostic.line}:${diagnostic.column}): ${diagnostic.message}\n`
  );
}
