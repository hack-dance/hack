import { resolveTimeoutOverrideMs } from "./duration.ts";

/**
 * Bounds for `hack data` Docker calls. `commandMs` bounds each metadata call
 * (Compose model, inspect, ps, create, start, rm); `stepMs` bounds each
 * helper step that reads or writes a whole volume (a digest, the tar, the
 * archive digest, an extract). A step past its bound kills the client, and
 * the held helper container is force-removed.
 */
export type DataBackupDeadlines = {
  readonly commandMs: number;
  readonly stepMs: number;
};

export const DATA_COMMAND_TIMEOUT_ENV = "HACK_DATA_COMMAND_TIMEOUT_MS";
export const DATA_STEP_TIMEOUT_ENV = "HACK_DATA_STEP_TIMEOUT_MS";

/** Two minutes per metadata call. */
export const DEFAULT_DATA_COMMAND_TIMEOUT_MS = 120_000;
/**
 * Four hours per whole-volume step: about 1 TiB at 75 MiB/s. Raise it with
 * {@link DATA_STEP_TIMEOUT_ENV} for larger or slower volumes.
 */
export const DEFAULT_DATA_STEP_TIMEOUT_MS = 4 * 60 * 60 * 1000;

export function resolveDataBackupDeadlines(
  env: Readonly<Record<string, string | undefined>> = process.env
): DataBackupDeadlines {
  return {
    commandMs: resolveTimeoutOverrideMs({
      name: DATA_COMMAND_TIMEOUT_ENV,
      fallback: DEFAULT_DATA_COMMAND_TIMEOUT_MS,
      max: 60 * 60 * 1000,
      env,
    }),
    stepMs: resolveTimeoutOverrideMs({
      name: DATA_STEP_TIMEOUT_ENV,
      fallback: DEFAULT_DATA_STEP_TIMEOUT_MS,
      max: 7 * 24 * 60 * 60 * 1000,
      env,
    }),
  };
}
