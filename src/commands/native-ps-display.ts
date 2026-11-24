import type { NativeImageTagStatus } from "../backends/native-image-tags.ts";
import type { NativeProjectPsResult } from "../backends/native-project-observe.ts";
import { NATIVE_PROVIDER_PIN_MESSAGE } from "../backends/native-runtime-client.ts";
import { emitCliResult, okResult } from "../lib/cli-result.ts";
import { display } from "../ui/display.ts";
import { logger } from "../ui/logger.ts";
import { psServiceState, renderPs } from "../ui/ps-output.ts";
import { createTextOutput } from "../ui/text-output.ts";

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
  result: NativeProjectPsResult & {
    imageTags?: readonly NativeImageTagStatus[];
  },
  json: boolean,
  ps?: {
    readonly addresses: ReadonlyMap<string, readonly string[]>;
    readonly wide?: boolean;
    readonly recoveryCommand?: string;
  }
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
  } else if (result.status === "runtime_busy" && !ps) {
    logger.info({
      message:
        "Native runtime is busy with another operation, such as a starting hack up; service state is available once it finishes or reports ready.",
    });
  } else if (result.status === "provider_pin_changed") {
    logger.warn({ message: NATIVE_PROVIDER_PIN_MESSAGE });
  } else if (result.status === "owner_unconfirmed" && !ps) {
    logger.warn({
      message:
        "Native graph owner is unconfirmed. Service rows are observations, not usable readiness; explicit retaining recovery is required.",
    });
  } else if (result.status === "runtime_degraded" && !ps) {
    logger.warn({
      message:
        "Native graph owner reported a degraded runtime. Service rows do not prove usable readiness. Run hack down to stop this project with data retained.",
    });
  }
  if (ps) {
    displayNativeServiceRows(result, ps);
    if (ps.wide && result.imageTags?.length) {
      createTextOutput().table({
        columns: [
          "IMAGE TAG",
          "RESOLVED DIGEST",
          "IMAGE ID",
          "PLATFORM",
          "RESOLVED AT",
        ],
        rows: result.imageTags.flatMap((tag) =>
          tag.selections.map((selection) => [
            tag.reference,
            selection.source_digest ?? tag.source_digest,
            selection.image_id,
            selection.platform,
            formatResolvedAt(
              selection.resolved_at_unix_seconds ?? tag.resolved_at_unix_seconds
            ),
          ])
        ),
      });
    }
    return;
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

function displayNativeServiceRows(
  result: NativeProjectPsResult,
  ps: {
    readonly addresses: ReadonlyMap<string, readonly string[]>;
    readonly wide?: boolean;
    readonly recoveryCommand?: string;
  }
): void {
  const output = createTextOutput();
  const starting = result.phase === "preparing" || result.phase === "restoring";
  const portServices = new Set(result.ports?.map((port) => port.service));
  for (const item of result.items) {
    portServices.delete(item.service);
  }
  const rows = [
    ...result.items.map((item) => ({
      service: item.service,
      container: item.container,
      exitCode: item.exitCode,
      state: psServiceState(item),
    })),
    ...[...portServices].map((service) => ({
      service,
      container: null,
      exitCode: null,
      state: "unconfirmed",
    })),
  ].map((row) => {
    const ports = result.ports?.filter((port) => port.service === row.service);
    return {
      ...row,
      address: null,
      addresses: starting ? undefined : ps.addresses.get(row.service),
      ports:
        ports
          ?.map((port) => `127.0.0.1:${port.port} (${port.state})`)
          .join(", ") || null,
      state: ports?.some((port) => port.state === "down")
        ? "port-down"
        : row.state,
    };
  });
  if (rows.length === 0 && result.status === "runtime_busy") {
    output.line("service status is being updated", "faint");
    return;
  }
  const ownerUnconfirmed = result.status === "owner_unconfirmed";
  const degraded =
    result.status === "runtime_degraded" ||
    rows.some((row) => row.state === "port-down");
  if (
    rows.length > 0 ||
    !(ownerUnconfirmed || degraded || result.status === "provider_pin_changed")
  ) {
    renderPs({
      rows,
      output,
      wide: ps.wide,
      hintWhenEmpty: result.status === "not_started",
    });
  }
  if (ownerUnconfirmed || degraded) {
    const reason = ownerUnconfirmed
      ? "owner is unconfirmed"
      : "runtime is degraded";
    output.line(
      `${reason} · retain data and stop with ${ps.recoveryCommand ?? "hack down"}`,
      "faint"
    );
  }
}

function formatResolvedAt(seconds: number): string | null {
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
