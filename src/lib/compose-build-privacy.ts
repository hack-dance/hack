import { readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import createDockerignore from "@balena/dockerignore";
import { YAML } from "bun";
import type { RuntimeUpOptions } from "../backends/runtime-backend.ts";
import policy from "../project-private-files.json";
import { readTextFile } from "./fs.ts";
import { isRecord } from "./guards.ts";
import { exec } from "./shell.ts";

let warningFormat: "json" | "text" | undefined;
const IGNORE_LITERAL = /^[ /A-Za-z0-9_.-]+$/;
const privateNames = createDockerignore({ ignorecase: false }).add([
  ...policy.hackDirIgnore,
  ...policy.generatedStateDirs,
  policy.privateStagingDir,
]);

export function beginComposeBuildWarnings(json: boolean): void {
  warningFormat = json ? "json" : "text";
}

const inside = (member: string) =>
  member !== ".." && !member.startsWith("../") && !path.isAbsolute(member);

async function hackDirectory(context: string, base: string) {
  const relative = path.relative(context, base);
  const direct = path.basename(context) === ".hack" ? "" : ".hack";
  const hack =
    path.basename(base) === ".hack" && inside(relative)
      ? base
      : path.join(context, direct);
  return (await stat(hack).catch(() => null))?.isDirectory() ? hack : null;
}

function services(document: unknown) {
  return isRecord(document) && isRecord(document.services)
    ? Object.entries(document.services)
    : [];
}

async function mayExpose(files: readonly string[], base: string) {
  for (const composeFile of files) {
    const document = YAML.parse((await readTextFile(composeFile)) ?? "");
    if (isRecord(document) && document.include) {
      return true;
    }
    for (const [, value] of services(document)) {
      const { build, extends: inherited } = isRecord(value) ? value : {};
      const context = isRecord(build) ? build.context : build;
      const source = typeof context === "string" ? context : ".";
      if (
        inherited ||
        (build &&
          (source.includes("$") ||
            (await hackDirectory(path.resolve(base, source), base))))
      ) {
        return true;
      }
    }
  }
  return false;
}

// Match the known prefix only. The remaining pattern can name a descendant,
// so the warning does not need to open or enumerate the private directory.
function exceptionReaches(member: string, rule: string): boolean {
  const parts = path.posix.resolve("/", rule).slice(1).split("/");
  for (const name of member.split("/")) {
    const part = parts.shift();
    if (!part || part.includes("**")) {
      return true;
    }
    if (!createDockerignore({ ignorecase: false }).add(part).ignores(name)) {
      return false;
    }
  }
  return true;
}

async function exposedComposeBuildPaths(
  build: Record<string, unknown>,
  base: string
) {
  const context = build.context;
  if (typeof context !== "string" || !path.isAbsolute(context)) {
    return null;
  }
  const hack = await hackDirectory(context, base);
  if (!hack) {
    return null;
  }
  const dockerfile =
    typeof build.dockerfile === "string" ? build.dockerfile : "Dockerfile";
  const specific = `${path.resolve(context, dockerfile)}.dockerignore`;
  const ignoreFile =
    build.dockerfile_inline === undefined && (await Bun.file(specific).exists())
      ? specific
      : path.join(context, ".dockerignore");
  const rules = (await readTextFile(ignoreFile)) ?? "";
  const ignore = createDockerignore({ ignorecase: false }).add(rules);
  const exceptions = rules.split("\n").flatMap((line) => {
    const rule = line.trim();
    return rule.startsWith("!") && rule.length > 1
      ? [rule.slice(1).trim()]
      : [];
  });
  const paths = (await readdir(hack))
    .filter((name) => privateNames.ignores(name))
    .map((name) => path.relative(context, path.join(hack, name)));
  const checkout = path.dirname(hack);
  if (inside(path.relative(context, checkout))) {
    for (const name of [policy.envKey, policy.privateStagingDir]) {
      const entry = path.join(checkout, name);
      if (await stat(entry).catch(() => null)) {
        paths.push(path.relative(context, entry));
      }
    }
  }
  const reIncluded = paths.filter((member) =>
    exceptions.some((rule) => exceptionReaches(member, rule))
  );
  const lines = paths
    .filter(
      (member) =>
        IGNORE_LITERAL.test(member) &&
        (!ignore.ignores(member) || reIncluded.includes(member))
    )
    .sort()
    .map((path) => `/${path}`);
  return lines.length
    ? { ignoreFile, lines, hasExceptions: reIncluded.length > 0 }
    : null;
}

type BuildScope = { readonly argv: readonly string[] } & Pick<
  RuntimeUpOptions,
  "composeFiles" | "cwd" | "env" | "services" | "noDeps"
>;

async function buildFindings(opts: BuildScope, base: string) {
  if (!(await mayExpose(opts.composeFiles, base))) {
    return [];
  }
  const command = ["config", "--format=json", "--no-env-resolution"];
  const config = await exec(opts.argv.concat(command, opts.services ?? []), {
    ...opts,
    timeoutMs: 3000,
    maxStdoutBytes: 2 * 1024 * 1024,
    stdin: "ignore",
    maxStderrBytes: 4096,
  });
  const selected = opts.noDeps ? opts.services : undefined;
  const entries = services(
    config.exitCode === 0 &&
      JSON.parse(Buffer.from(config.stdout, "latin1").toString())
  );
  const findings: (NonNullable<
    Awaited<ReturnType<typeof exposedComposeBuildPaths>>
  > & { service: string })[] = [];
  for (const [service, value] of entries) {
    if (
      isRecord(value) &&
      isRecord(value.build) &&
      (!selected || selected.includes(service))
    ) {
      const exposure = await exposedComposeBuildPaths(value.build, base);
      if (exposure) {
        findings.push({ service, ...exposure });
      }
    }
  }
  return findings;
}

export async function warnComposeBuildPrivacy(opts: BuildScope): Promise<void> {
  const first = opts.composeFiles[0];
  const findings =
    warningFormat &&
    first &&
    (await buildFindings(opts, path.dirname(first)).catch(() => []));
  if (!findings || findings.length === 0 || !warningFormat) {
    return;
  }
  const json = warningFormat === "json";
  warningFormat = undefined;
  const exceptions = findings.some(({ hasExceptions }) => hasExceptions)
    ? " A ! exception can re-include a private path. Remove or narrow it, or add the suggested lines after it."
    : "";
  const message =
    "Compose can send Hack's machine-local files to the builder. Add these lines to the effective Docker ignore files." +
    exceptions;
  process.stderr.write(
    json
      ? `${JSON.stringify({ level: "warning", code: "compose_build_private_files", message, findings })}\n`
      : `WARNING: ${message}\n${findings.map(({ service, ignoreFile, lines }) => [JSON.stringify(service), JSON.stringify(ignoreFile), ...lines].join("\n")).join("\n")}\n`
  );
}
