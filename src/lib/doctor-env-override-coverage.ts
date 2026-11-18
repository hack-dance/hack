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
 * A service needs an entry exactly when its effective env for the default
 * selection is non-empty: the renderer omits a service whose effective
 * bindings are empty, for example when a service scope removes every inherited
 * global key with `null`. The effective bindings come from
 * `resolveProjectEnvMetadata`, which reads key names and scopes only, acquires
 * no key and decrypts no value. Only running Compose services are expected;
 * host lifecycle processes are not Compose services and never have an entry.
 *
 * Reads service names and key names only; never a value. Messages name
 * services only.
 */

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { YAML } from "bun";
import { HACK_PROJECT_DIR_PRIMARY } from "../constants.ts";
import { COMPOSE_ENV_OVERRIDE_FILENAME } from "./compose-env-at-rest.ts";
import { isRecord } from "./guards.ts";
import { withProcessDeadline } from "./process-deadline.ts";
import { findProjectContext } from "./project.ts";
import { resolveProjectEnvMetadata } from "./project-env-config.ts";
import { scopeRuntimeHygieneToProject } from "./project-runtime-hygiene.ts";
import { readProjectsRegistry } from "./projects-registry.ts";
import { readRuntimeProjects } from "./runtime-projects.ts";

export const ENV_OVERRIDE_COVERAGE_CHECK = "env override coverage";

export type EnvOverrideCoverage =
  /** No generated override: nothing to cover. */
  | { readonly kind: "absent" }
  /** Not a services document Hack wrote; coverage cannot be judged. */
  | { readonly kind: "unverifiable" }
  /** No modern env config or an unreadable selection: not judged. */
  | { readonly kind: "no_metadata" }
  | {
      readonly kind: "covered" | "stale";
      /** Services the file has an entry for. */
      readonly services: readonly string[];
      /** Expected services with managed env and no entry; empty when covered. */
      readonly missing: readonly string[];
    };

/**
 * Coverage of the `expected` services by the override `text` (null when the
 * file does not exist). `managed` holds the services whose effective env is
 * non-empty, or null when it is unknown.
 */
export function inspectEnvOverrideCoverage(opts: {
  readonly text: string | null;
  readonly expected: readonly string[];
  readonly managed: ReadonlySet<string> | null;
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
  if (opts.managed === null) {
    return { kind: "no_metadata" };
  }
  const managed = opts.managed;
  const covered = Object.keys(services).sort();
  const present = new Set(covered);
  const missing = [...new Set(opts.expected)]
    .filter((service) => managed.has(service) && !present.has(service))
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
  /** True when the expected services are running containers, false the Compose file's. */
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
    case "no_metadata":
      return {
        name,
        status: "ok",
        message: `No modern env config could be read, so the coverage of ${opts.file} is not judged.`,
      };
    case "covered":
      return {
        name,
        status: "ok",
        message: opts.running
          ? `${opts.file} covers every running service with managed env.`
          : `${opts.file} covers every Compose service with managed env (running containers not inspected).`,
      };
    default: {
      const list = coverage.missing.join(", ");
      const which = opts.running ? "running service" : "Compose service";
      const count = coverage.missing.length;
      return {
        name,
        status: "warn",
        message: `${opts.file} has no entry for ${count === 1 ? `${which} ${list}` : `${count} ${which}s: ${list}`}, which ${count === 1 ? "has" : "have"} managed env. An older Hack wrote it for a targeted command (hack restart, up, run or exec with a service), so a later Compose command can recreate ${count === 1 ? "that service" : "those services"} without ${count === 1 ? "its" : "their"} managed variables. Run \`hack up\` once to regenerate it for every service.`,
      };
    }
  }
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

/**
 * Services with non-empty effective env for the default selection, or null
 * when there is no modern env config or it cannot be read. Names only.
 */
async function managedServices(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly serviceNames: readonly string[];
}): Promise<ReadonlySet<string> | null> {
  try {
    const metadata = await resolveProjectEnvMetadata(opts);
    if (!metadata) {
      return null;
    }
    return new Set(
      opts.serviceNames.filter((service) => {
        const keys = Object.hasOwn(metadata.effectiveMetadata, service)
          ? metadata.effectiveMetadata[service]
          : undefined;
        return keys !== undefined && Object.keys(keys).length > 0;
      })
    );
  } catch {
    return null;
  }
}

/** Bound for the Docker reads below; past it the check uses the Compose file. */
const OBSERVATION_DEADLINE_MS = 15_000;

/**
 * Service and state of this checkout's containers, or null when Docker could
 * not be read. No image inspection: the check needs only which services run.
 * The process deadline also ends the Docker children, so a slow engine cannot
 * keep the doctor alive past the check.
 */
async function observeServiceStates(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
}): Promise<
  readonly { readonly service: string; readonly state: string }[] | null
> {
  try {
    return await withProcessDeadline(
      Date.now() + OBSERVATION_DEADLINE_MS,
      async () => {
        const [registry, runtime] = await Promise.all([
          readProjectsRegistry(),
          readRuntimeProjects({ includeGlobal: false }),
        ]);
        if (!runtime.ok) {
          return null;
        }
        const scoped = scopeRuntimeHygieneToProject({
          projectRoot: opts.projectRoot,
          projectDir: opts.projectDir,
          projects: registry.projects,
          runtime: runtime.runtime,
        });
        return scoped.runtime.flatMap((project) =>
          [...project.services.values()].flatMap((service) =>
            service.containers.map((container) => ({
              service: service.service,
              state: container.state,
            }))
          )
        );
      }
    );
  } catch {
    return null;
  }
}

/**
 * Running services that belong to the Compose graph. Host lifecycle processes
 * appear in the runtime view with their process name but are not Compose
 * services, so the override never has an entry for them.
 */
export function runningComposeServices(opts: {
  readonly graph: readonly string[];
  readonly containers: readonly {
    readonly service: string;
    readonly state: string;
  }[];
}): string[] {
  const inGraph = new Set(opts.graph);
  return opts.containers
    .filter(
      (container) =>
        container.state.toLowerCase() === "running" &&
        inGraph.has(container.service)
    )
    .map((container) => container.service);
}

/**
 * The check for the project at `startDir`. With Docker, the expected services
 * are this checkout's running Compose services; without it, the Compose
 * file's services (what a later command could start).
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
  const graph = composeServices(
    await readFile(ctx.composeFile, "utf8").catch(() => "")
  );
  const containers = opts.dockerOk
    ? await observeServiceStates({
        projectRoot: ctx.projectRoot,
        projectDir: ctx.projectDir,
      })
    : null;
  const expected =
    containers === null ? graph : runningComposeServices({ graph, containers });
  const managed =
    text === null
      ? null
      : await managedServices({
          projectRoot: ctx.projectRoot,
          projectDir: ctx.projectDir,
          serviceNames: graph,
        });
  return envOverrideCoverageCheck({
    coverage: inspectEnvOverrideCoverage({ text, expected, managed }),
    file,
    running: containers !== null,
  });
}
