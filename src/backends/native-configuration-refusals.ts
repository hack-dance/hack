import { isRecord } from "../lib/guards.ts";

const SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TEXT = /^[\x20-\x7e]{1,400}$/;
const FIELDS = new Set([
  "ports",
  "labels",
  "logging.driver",
  "platform",
  "networks",
  "network_mode",
  "volumes",
  "volumes.volume.subpath",
  "healthcheck",
  "healthcheck.x-hack-http",
  "labels.caddy",
  "labels.caddy.tls",
  "labels.caddy.reverse_proxy",
  "labels.hack.dependencies.cache-volume",
  "labels.hack.dependencies.lockfiles",
  "labels.hack.dependencies.runtime-files",
  "labels.hack.dependencies.bootstrap",
]);

export type NativeConfigurationRefusal = {
  readonly service?: string;
  readonly field: string;
  readonly message: string;
  readonly fix: string;
};

/** Runtime literals only, with closed field paths and bounded service identifiers.
 * Like message_fixed, text_fixed is set by the Rust literal-only constructor.
 * The whole batch is rejected on malformed input; raw runtime text never escapes.
 */
export function readNativeConfigurationRefusals(
  value: unknown
): readonly NativeConfigurationRefusal[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4096) {
    return;
  }
  const result: NativeConfigurationRefusal[] = [];
  for (const item of value) {
    if (
      !(
        isRecord(item) &&
        item.text_fixed === true &&
        typeof item.field === "string" &&
        FIELDS.has(item.field) &&
        typeof item.message === "string" &&
        TEXT.test(item.message) &&
        typeof item.fix === "string" &&
        TEXT.test(item.fix) &&
        (item.service == null ||
          (typeof item.service === "string" && SERVICE.test(item.service)))
      )
    ) {
      return;
    }
    result.push({
      field: item.field,
      message: item.message,
      fix: item.fix,
      ...(typeof item.service === "string" ? { service: item.service } : {}),
    });
  }
  return result;
}
