/**
 * Whether Hack runs the global logging stack (Loki, Alloy, Grafana).
 *
 * The stack is opt-in. `logging.enabled` in the global config decides; when
 * it is unset, a home that already has the stack's directory keeps it on
 * (every `hack global install` before opt-in wrote that file and started
 * the stack), and any other home has it off. So an upgrade never stops a
 * stack someone uses, and a new home never starts one nobody asked for.
 *
 * Turning the stack off stops its containers and keeps their volumes: logs,
 * Grafana state and Alloy's read positions stay until `hack global
 * logs-reset`. Plain `hack logs` reads container logs either way.
 */
import { dirname, resolve } from "node:path";
import {
  GLOBAL_LOGGING_COMPOSE_FILENAME,
  GLOBAL_LOGGING_DIR_NAME,
} from "../constants.ts";
import { readGlobalConfig } from "./config.ts";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { pathExists } from "./fs.ts";

export const LOGGING_ENABLED_CONFIG_KEY = "logging.enabled" as const;

/** Stable error code when a command needs the stack while it is off. */
export const LOGGING_OFF_CODE = "E_LOGGING_OFF" as const;

/** The command that turns the stack on; named in every "off" message. */
export const LOGGING_ENABLE_COMMAND = "hack global up --logging" as const;

export type GlobalLoggingSetting = {
  readonly enabled: boolean;
  /**
   * `config`: `logging.enabled` is set; `existing-home`: unset, and the
   * home has the stack's directory (`logging/`, which every install before
   * opt-in wrote); `default`: unset, no such directory.
   */
  readonly source: "config" | "existing-home" | "default";
};

/** A `logging.enabled` value: a boolean, or the strings `true`/`false`. */
export function parseLoggingEnabled(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true" || value === "false") {
    return value === "true";
  }
  throw new Error(
    `${LOGGING_ENABLED_CONFIG_KEY} must be true or false (got ${JSON.stringify(value)}). Fix it with: hack config set --global ${LOGGING_ENABLED_CONFIG_KEY} false`
  );
}

/**
 * The effective setting for the home whose logging compose file is
 * `loggingCompose`. Reads one config value and checks one path; no Docker.
 */
export async function resolveGlobalLogging(opts: {
  readonly loggingCompose: string;
}): Promise<GlobalLoggingSetting> {
  const configured = await readGlobalConfig({
    path: LOGGING_ENABLED_CONFIG_KEY,
  });
  if (configured !== undefined) {
    return { enabled: parseLoggingEnabled(configured), source: "config" };
  }
  // The directory, not the compose file in it: a compose file moved aside
  // (as the login refusal suggests for unexpected files) is not an opt-out.
  return (await pathExists(dirname(opts.loggingCompose)))
    ? { enabled: true, source: "existing-home" }
    : { enabled: false, source: "default" };
}

/**
 * Resolves the setting and, for a home that kept the stack because it had
 * the compose file (`existing-home`), saves `logging.enabled: true`, so the
 * choice no longer depends on that file: a missing or moved compose file
 * then means "write it again", not "logging is off" while its containers
 * still run. Returns the setting as saved, and whether it was just saved.
 */
export async function resolveAndSaveGlobalLogging(opts: {
  readonly loggingCompose: string;
  readonly save: (value: boolean) => Promise<unknown>;
}): Promise<
  GlobalLoggingSetting & {
    readonly saved: boolean;
    /** Set when saving failed: the choice still holds for this run. */
    readonly saveError?: string;
  }
> {
  const setting = await resolveGlobalLogging(opts);
  if (setting.source !== "existing-home") {
    return { ...setting, saved: false };
  }
  try {
    await opts.save(true);
  } catch (error) {
    // Not saved: the stack stays on for this run (the directory marker still
    // decides next time), and the caller reports it. Routing is not blocked.
    return {
      ...setting,
      saved: false,
      saveError: error instanceof Error ? error.message : String(error),
    };
  }
  return { enabled: true, source: "config", saved: true };
}

/**
 * The setting `hack global up --logging` / `--no-logging` asks for: `true`,
 * `false`, `null` for neither, or `conflict` for both.
 */
export function resolveLoggingFlag(options: {
  readonly logging?: boolean | undefined;
  readonly noLogging?: boolean | undefined;
}): boolean | null | "conflict" {
  if (options.logging === true && options.noLogging === true) {
    return "conflict";
  }
  if (options.logging === true) {
    return true;
  }
  return options.noLogging === true ? false : null;
}

/** The setting for the current Hack home (`HACK_HOME`, else `~/.hack`). */
export async function resolveGlobalLoggingForHome(): Promise<GlobalLoggingSetting> {
  return await resolveGlobalLogging({
    loggingCompose: resolve(
      resolveGlobalHackDir(),
      GLOBAL_LOGGING_DIR_NAME,
      GLOBAL_LOGGING_COMPOSE_FILENAME
    ),
  });
}

/** One line for commands that need the stack while it is off. */
export function renderLoggingOffMessage(opts: {
  /** What could not run, for example "Loki-backed logs". */
  readonly feature: string;
}): string {
  return `${opts.feature} cannot run: the global logging stack (Loki, Alloy, Grafana) is off. Turn it on with: ${LOGGING_ENABLE_COMMAND}`;
}

/**
 * Where `hack logs` looks for Loki: `HACK_LOKI_URL` (the user's own Loki,
 * which also bypasses the `logging.enabled` setting), else the local
 * logging stack's published port. `HACK_TEST_LOCAL_LOKI_URL` moves that
 * local address for tests, so a test never reaches a Loki the machine runs;
 * unlike `HACK_LOKI_URL` it leaves the setting in force.
 */
export function lokiBaseUrl(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  return (
    env.HACK_LOKI_URL ??
    env.HACK_TEST_LOCAL_LOKI_URL ??
    "http://127.0.0.1:3100"
  ).trim();
}
