import { resolve } from "node:path";
import { PROJECT_CONFIG_FILENAME } from "../../constants.ts";
import { HackCliError } from "../cli-result.ts";
import { readGlobalConfig } from "../config.ts";
import { readTextFile } from "../fs.ts";
import { isRecord } from "../guards.ts";
import type { CaptureMode } from "./journal.ts";

export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000;
export const MIN_TIMEOUT_MS = 1000;
export const DEFAULT_STALL_AFTER_MS = 120_000;
export const MAX_STALL_AFTER_MS = MAX_TIMEOUT_MS;
export const MAX_RETENTION_HOURS = 24;

/** `backgroundCommands` in the global or project hack.config.json. */
export type BackgroundCommandConfig = {
  /** Global only: `"off"` stores no output for any background command. */
  readonly capture?: CaptureMode | "off";
  /** 0 to 24. The global value is a ceiling for project values. */
  readonly retentionHours?: number;
  /** Project default; 0 turns stall detection off. */
  readonly stallAfterMs?: number;
};

export type BackgroundCommandRequest = {
  readonly capture?: CaptureMode;
  readonly timeoutMs?: number;
  readonly stallAfterMs?: number;
};

export type ResolvedBackgroundSettings = {
  readonly capture: CaptureMode;
  readonly timeoutMs: number;
  readonly stallAfterMs: number;
  readonly retentionMs: number;
};

function configError(message: string): HackCliError {
  return new HackCliError({ code: "E_CONFIG_INVALID", message });
}

export function parseBackgroundCommandConfig(opts: {
  readonly value: unknown;
  readonly scope: "global" | "project";
}): BackgroundCommandConfig {
  if (opts.value === undefined) {
    return {};
  }
  const label = `${opts.scope} backgroundCommands`;
  if (!isRecord(opts.value)) {
    throw configError(`The ${label} setting must be an object.`);
  }
  const { capture, retentionHours, stallAfterMs } = opts.value;
  const allowed =
    opts.scope === "global"
      ? ["full", "metadata", "off"]
      : ["full", "metadata"];
  if (
    capture !== undefined &&
    !(typeof capture === "string" && allowed.includes(capture))
  ) {
    throw configError(
      `The ${label}.capture setting must be one of ${allowed.join(", ")}.`
    );
  }
  if (
    retentionHours !== undefined &&
    !(
      typeof retentionHours === "number" &&
      Number.isFinite(retentionHours) &&
      retentionHours >= 0 &&
      retentionHours <= MAX_RETENTION_HOURS
    )
  ) {
    throw configError(
      `The ${label}.retentionHours setting must be a number from 0 to ${MAX_RETENTION_HOURS}.`
    );
  }
  if (
    stallAfterMs !== undefined &&
    !(
      typeof stallAfterMs === "number" &&
      Number.isSafeInteger(stallAfterMs) &&
      stallAfterMs >= 0 &&
      stallAfterMs <= MAX_STALL_AFTER_MS
    )
  ) {
    throw configError(
      `The ${label}.stallAfterMs setting must be an integer from 0 to ${MAX_STALL_AFTER_MS}.`
    );
  }
  return {
    ...(capture === undefined
      ? {}
      : { capture: capture as CaptureMode | "off" }),
    ...(retentionHours === undefined ? {} : { retentionHours }),
    ...(stallAfterMs === undefined ? {} : { stallAfterMs }),
  };
}

/** Pure precedence: per call, then project default, then global, then built-in. */
export function resolveBackgroundSettings(opts: {
  readonly request: BackgroundCommandRequest;
  readonly project: BackgroundCommandConfig;
  readonly global: BackgroundCommandConfig;
}): ResolvedBackgroundSettings {
  const { request } = opts;
  if (
    request.timeoutMs !== undefined &&
    !(
      Number.isSafeInteger(request.timeoutMs) &&
      request.timeoutMs >= MIN_TIMEOUT_MS &&
      request.timeoutMs <= MAX_TIMEOUT_MS
    )
  ) {
    throw new HackCliError({
      code: "E_USAGE",
      message: `Background command timeout must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} ms.`,
    });
  }
  if (
    request.stallAfterMs !== undefined &&
    !(
      Number.isSafeInteger(request.stallAfterMs) &&
      request.stallAfterMs >= 0 &&
      request.stallAfterMs <= MAX_STALL_AFTER_MS
    )
  ) {
    throw new HackCliError({
      code: "E_USAGE",
      message: `Stall threshold must be an integer from 0 to ${MAX_STALL_AFTER_MS} ms (0 turns it off).`,
    });
  }
  const globallyOff = opts.global.capture === "off";
  if (globallyOff && request.capture === "full") {
    throw new HackCliError({
      code: "E_CAPTURE_DISABLED",
      message:
        'Output capture for background commands is turned off in the global config (backgroundCommands.capture = "off"). Start with capture "metadata", or change the setting.',
    });
  }
  const globalCapture =
    opts.global.capture === "off" ? "metadata" : opts.global.capture;
  const capture: CaptureMode = globallyOff
    ? "metadata"
    : (request.capture ??
      (opts.project.capture === "off" ? undefined : opts.project.capture) ??
      globalCapture ??
      "full");
  const ceiling = Math.min(
    opts.global.retentionHours ?? MAX_RETENTION_HOURS,
    MAX_RETENTION_HOURS
  );
  const retentionHours = Math.min(
    opts.project.retentionHours ?? ceiling,
    ceiling
  );
  return {
    capture,
    timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    stallAfterMs:
      request.stallAfterMs ??
      opts.project.stallAfterMs ??
      opts.global.stallAfterMs ??
      DEFAULT_STALL_AFTER_MS,
    retentionMs: Math.round(retentionHours * 60 * 60 * 1000),
  };
}

/** Read both config layers. Hack config never holds secret values. */
export async function readBackgroundCommandConfigs(opts: {
  readonly projectDir: string | null;
}): Promise<{
  readonly project: BackgroundCommandConfig;
  readonly global: BackgroundCommandConfig;
}> {
  const global = parseBackgroundCommandConfig({
    value: await readGlobalConfig({ path: "backgroundCommands" }),
    scope: "global",
  });
  let projectValue: unknown;
  if (opts.projectDir) {
    const text = await readTextFile(
      resolve(opts.projectDir, PROJECT_CONFIG_FILENAME)
    );
    if (text !== null) {
      try {
        const parsed: unknown = JSON.parse(text);
        projectValue = isRecord(parsed) ? parsed.backgroundCommands : undefined;
      } catch {
        projectValue = undefined; // The command itself reports parse errors.
      }
    }
  }
  return {
    global,
    project: parseBackgroundCommandConfig({
      value: projectValue,
      scope: "project",
    }),
  };
}
