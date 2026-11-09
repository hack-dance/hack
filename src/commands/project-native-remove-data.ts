import { nativeProjectRemoveData } from "../backends/native-project-down.ts";
import type { NativeProjectRunScope } from "../backends/native-project-run.ts";
import type { NativeRuntimeSelection } from "../backends/native-runtime-client.ts";
import { HackCliError } from "../lib/cli-result.ts";
import { confirmSafe } from "../lib/interactivity.ts";
import { logger } from "../ui/logger.ts";

const CONFIRM_HINT =
  "Re-run with --remove-data --yes to confirm non-interactively.";

/**
 * `hack down --remove-data` on the native backend: explicit, confirmed
 * deletion of a stopped project's graph-owned data volumes. Asks once unless
 * `--yes` is given; `--json` without `--yes` refuses with
 * `E_INTERACTIVE_REQUIRED` before any runtime request. Output names no
 * volume, path or other authored value. SIGINT/SIGTERM cancel the removal:
 * its owned runtime request is settled and the operation lock released
 * before the command fails.
 */
export async function runNativeDownRemoveData(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly yes: boolean;
  readonly json: boolean;
  readonly remove?: typeof nativeProjectRemoveData;
}): Promise<number> {
  if (opts.json && !opts.yes) {
    throw new HackCliError({
      code: "E_INTERACTIVE_REQUIRED",
      message: `Removing native project data requires confirmation. ${CONFIRM_HINT}`,
    });
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  let result: Awaited<ReturnType<typeof nativeProjectRemoveData>>;
  try {
    result = await (opts.remove ?? nativeProjectRemoveData)({
      runtime: opts.runtime,
      scope: opts.scope,
      signal: controller.signal,
      ...(opts.yes
        ? {}
        : {
            confirm: () =>
              confirmSafe({
                message:
                  "Delete this project's stopped native data volumes? This cannot be undone; shared dependency caches are kept.",
                initialValue: false,
                nonInteractive: "fail",
                hint: CONFIRM_HINT,
              }),
          }),
    });
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  const messages = {
    removed:
      "Native project data removed; the next `hack up` starts with new empty volumes.",
    kept: "Nothing was removed; native project data is retained.",
    not_started: "Native project is not started; there is no retained data.",
  } as const;
  logger.info({ message: messages[result.status] });
  return 0;
}
