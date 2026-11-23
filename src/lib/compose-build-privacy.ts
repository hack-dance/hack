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
  const ignore = createDockerignore({ ignorecase: false }).add(
    (await readTextFile(ignoreFile)) ?? ""
  );
  const paths = (await readdir(hack))
    .filter((name) => privateNames.ignores(name))
    .map((name) => path.relative(context, path.join(hack, name)));
  const key = path.join(path.dirname(hack), policy.envKey);
  if (inside(path.relative(context, key)) && (await Bun.file(key).exists())) {
    paths.push(path.relative(context, key));
  }
  const lines = paths
    .filter((member) => IGNORE_LITERAL.test(member) && !ignore.ignores(member))
    .sort()
    .map((path) => `/${path}`);
  return lines.length ? { ignoreFile, lines } : null;
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
  const findings: { service: string; ignoreFile: string; lines: string[] }[] =
    [];
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
  const message =
    "Compose can send Hack's machine-local files to the builder. Add these lines to the effective Docker ignore files.";
  process.stderr.write(
    json
      ? `${JSON.stringify({ level: "warning", code: "compose_build_private_files", message, findings })}\n`
      : `WARNING: ${message}\n${findings.map(({ service, ignoreFile, lines }) => [JSON.stringify(service), JSON.stringify(ignoreFile), ...lines].join("\n")).join("\n")}\n`
  );
}
