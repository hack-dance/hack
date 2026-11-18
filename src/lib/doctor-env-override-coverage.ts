/**
 * Doctor check: does the generated Compose env override cover every running
 * service (HACK-2325)?
 *
 * Before HACK-2325 a targeted command (`hack restart api`, `hack up api`,
 * `hack run`, `hack exec`) rewrote `.hack/.internal/compose.env.override.yml`
 * for its targets only. Compose loads that file for every command of the
 * instance, so a later command that recreated another service did so without
 * that service's managed variables. Current Hack renders every service of the
 * Compose graph, so one `hack up` repairs the file.
 *
 * The check is deterministic, not a guess: a full render gives every service
 * an entry whenever the selection has global env, because a service without
 * its own scope takes the global values. A global value is recognisable by its
 * shared reference name. So when the file holds a global reference and a
 * running service has no entry, the file was written by an older targeted
 * command. Without a global reference a missing service may simply have no
 * managed env, and the check reports nothing.
 *
 * Reads service names and reference names only, never a value.
 */

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { YAML } from "bun";
import { HACK_PROJECT_DIR_PRIMARY } from "../constants.ts";
import { COMPOSE_ENV_OVERRIDE_FILENAME } from "./compose-env-at-rest.ts";
import { composeEnvGlobalReferenceName } from "./compose-managed-env.ts";
import { observeDevRuntime } from "./doctor-dev-performance.ts";
import { isRecord } from "./guards.ts";
import { findProjectContext } from "./project.ts";

export const ENV_OVERRIDE_COVERAGE_CHECK = "env override coverage";

/** One bare `${NAME}` reference, the only value form Hack writes. */
const REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export type EnvOverrideCoverage =
  /** No generated override: nothing to cover. */
  | { readonly kind: "absent" }
  /** Not a services document Hack wrote; coverage cannot be judged. */
  | { readonly kind: "unverifiable" }
  /** No global reference, so a missing service may have no managed env. */
  | { readonly kind: "no_global_env"; readonly services: readonly string[] }
  | {
      readonly kind: "covered" | "stale";
      readonly services: readonly string[];
      /** Expected services without an entry; empty when covered. */
      readonly missing: readonly string[];
    };

function referenceName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = REFERENCE.exec(value);
  return match?.[1] ?? null;
}

/**
 * Coverage of `expected` service names by the override `text` (null when the
 * file does not exist).
 */
export function inspectEnvOverrideCoverage(opts: {
  readonly text: string | null;
  readonly expected: readonly string[];
}): EnvOverrideCoverage {
  if (opts.text === null) {
    return { kind: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(opts.text);
  } catch {
    return { kind: "unverifiable" };
  }
  if (parsed === null || parsed === undefined) {
    return { kind: "absent" };
  }
  const services = isRecord(parsed) ? parsed.services : undefined;
  if (!isRecord(services)) {
    return { kind: "unverifiable" };
  }
  let hasGlobal = false;
  for (const spec of Object.values(services)) {
    const environment = isRecord(spec) ? spec.environment : undefined;
    if (!isRecord(environment)) {
      continue;
    }
    for (const [key, value] of Object.entries(environment)) {
      if (referenceName(value) === composeEnvGlobalReferenceName({ key })) {
        hasGlobal = true;
      }
    }
  }
  const covered = Object.keys(services).sort();
  if (!hasGlobal) {
    return { kind: "no_global_env", services: covered };
  }
  const present = new Set(covered);
  const missing = [...new Set(opts.expected)]
    .filter((service) => !present.has(service))
    .sort();
  return {
    kind: missing.length > 0 ? "stale" : "covered",
    services: covered,
    missing,
  };
}

/** The doctor result for one coverage reading. */
export function envOverrideCoverageCheck(opts: {
  readonly coverage: EnvOverrideCoverage;
  /** Project-relative override path, for messages. */
  readonly file: string;
  /** True when `expected` came from running containers, false from the Compose file. */
  readonly running: boolean;
}): {
  readonly name: string;
  readonly status: "ok" | "warn";
  readonly message: string;
} {
  const name = ENV_OVERRIDE_COVERAGE_CHECK;
  const { coverage } = opts;
  switch (coverage.kind) {
    case "absent":
      return {
        name,
        status: "ok",
        message: "No generated Compose env override; nothing to cover.",
      };
    case "unverifiable":
      return {
        name,
        status: "ok",
        message: `${opts.file} is not a services document Hack wrote; its coverage is not judged.`,
      };
    case "no_global_env":
      return {
        name,
        status: "ok",
        message: `${opts.file} has no global env, so a service without an entry may have no managed variables; coverage is not judged.`,
      };
    case "covered":
      return {
        name,
        status: "ok",
        message: opts.running
          ? `${opts.file} covers every running service.`
          : `${opts.file} covers every service in the Compose file (running containers not inspected).`,
      };
    default: {
      const list = coverage.missing.join(", ");
      const which = opts.running ? "running service" : "Compose service";
      const count = coverage.missing.length;
      return {
        name,
        status: "warn",
        message: `${opts.file} has no entry for ${count === 1 ? `${which} ${list}` : `${count} ${which}s: ${list}`}. An older Hack wrote it for a targeted command (hack restart, up, run or exec with a service), so a later Compose command can recreate ${count === 1 ? "that service" : "those services"} without ${count === 1 ? "its" : "their"} managed variables. Run \`hack up\` once to regenerate it for every service.`,
      };
    }
  }
}

/**
 * The check for the project at `startDir`. With Docker, the expected services
 * are this checkout's running containers; without it, the Compose file's
 * services (what a later command could start).
 */
export async function checkEnvOverrideCoverage(opts: {
  readonly startDir: string;
  readonly dockerOk: boolean;
}): Promise<ReturnType<typeof envOverrideCoverageCheck>> {
  const ctx = await findProjectContext(opts.startDir);
  if (!ctx) {
    return {
      name: ENV_OVERRIDE_COVERAGE_CHECK,
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
    };
  }
  const path = join(ctx.projectDir, ".internal", COMPOSE_ENV_OVERRIDE_FILENAME);
  const file = relative(ctx.projectRoot, path) || path;
  let text: string | null = null;
  try {
    text = await readFile(path, "utf8");
  } catch {
    text = null;
  }
  const containers = opts.dockerOk
    ? await observeDevRuntime({
        projectRoot: ctx.projectRoot,
        projectDir: ctx.projectDir,
      })
    : null;
  const expected =
    containers === null
      ? composeServices(await readFile(ctx.composeFile, "utf8").catch(() => ""))
      : containers
          .filter((container) => container.state.toLowerCase() === "running")
          .map((container) => container.service);
  return envOverrideCoverageCheck({
    coverage: inspectEnvOverrideCoverage({ text, expected }),
    file,
    running: containers !== null,
  });
}

function composeServices(text: string): string[] {
  try {
    const parsed: unknown = YAML.parse(text);
    const services = isRecord(parsed) ? parsed.services : undefined;
    return isRecord(services) ? Object.keys(services) : [];
  } catch {
    return [];
  }
}
