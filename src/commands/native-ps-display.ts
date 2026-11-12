import type { NativeProjectPsResult } from "../backends/native-project-observe.ts";
import { NATIVE_PROVIDER_PIN_MESSAGE } from "../backends/native-runtime-client.ts";
import { emitCliResult, okResult } from "../lib/cli-result.ts";
import { display } from "../ui/display.ts";
import { logger } from "../ui/logger.ts";

export function nativePsState(
  item: NativeProjectPsResult["items"][number]
): string {
  return item.state === "exited" && item.exitCode !== null
    ? `exited (${item.exitCode})`
    : item.state;
}

/**
 * Native observation output shared by `hack ps` and `hack status`. `--json`
 * prints the standard `{ok: true, data}` envelope whose `data` is the native
 * ps result, matching authored native ps.
 */
export async function displayNativePs(
  result: NativeProjectPsResult,
  json: boolean
): Promise<void> {
  if (json) {
    emitCliResult({ result: okResult({ data: result }) });
    return;
  }
  if (result.status === "pending") {
    logger.info({
      message:
        "Native project startup is pending: a foreground up is starting, or an interrupted start retained its intent. No current service status is confirmed.",
    });
    return;
  }
  if (result.status === "not_started") {
    logger.info({ message: "Native project has not been started." });
  } else if (result.status === "runtime_not_running") {
    logger.info({
      message: "Native runtime is not running; no services are running.",
    });
  } else if (result.status === "runtime_busy") {
    logger.info({
      message:
        "Native runtime is busy with another operation, such as a starting hack up; service state is available once it finishes or reports ready.",
    });
  } else if (result.status === "provider_pin_changed") {
    logger.warn({ message: NATIVE_PROVIDER_PIN_MESSAGE });
  } else if (result.status === "owner_unconfirmed") {
    logger.warn({
      message:
        "Native graph owner is unconfirmed. Service rows are observations, not usable readiness; explicit retaining recovery is required.",
    });
  } else if (result.status === "runtime_degraded") {
    logger.warn({
      message:
        "Native graph owner reported a degraded runtime. Service rows do not prove usable readiness. Run hack down to stop this project with data retained.",
    });
  }
  await display.table({
    columns: ["NATIVE SERVICE", "CONTAINER", "STATE", "HEALTH"],
    rows: result.items.map((item) => [
      item.service,
      item.container ?? "",
      nativePsState(item),
      item.health ?? "",
    ]),
  });
  if (result.ports?.length) {
    await display.table({
      columns: ["NATIVE SERVICE", "PUBLISHED PORT", "STATE"],
      rows: result.ports.map((port) => [
        port.service,
        `127.0.0.1:${port.port}`,
        port.state,
      ]),
    });
  }
}
