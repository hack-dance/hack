/** Wire reader: opaque names are data, never trusted display labels. */
import { isRecord } from "./guards.ts";
export const TIMING_SCHEMA = "hack.timings/1";
const NAME = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const ID = /^[a-f0-9]+$/;
const NONZERO = /[1-9a-f]/;
export type TimingStep =
  | "command.total"
  | "runtime.request"
  | "timings.truncated";
export interface TimingRecord {
  schema: typeof TIMING_SCHEMA;
  trace: string;
  span: string;
  parent: string | null;
  proc: string;
  clock: string;
  origin_unix_us: number;
  origin_mono_us: number;
  step: string;
  start_us: number;
  dur_us: number;
  outcome: string;
  cached?: true;
  code?: string;
  attrs: Record<string, number | boolean>;
}
const name = (v: unknown): v is string =>
  typeof v === "string" && v.length <= 128 && NAME.test(v);
const id = (v: unknown, n: number): v is string =>
  typeof v === "string" && v.length === n && ID.test(v) && NONZERO.test(v);
const number = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
function known(value: unknown, allowed: readonly string[]): string {
  return typeof value === "string" && allowed.includes(value)
    ? value
    : "unknown";
}
export function readTimingLine(line: string): TimingRecord | undefined {
  if (Buffer.byteLength(line) > 16_384) {
    return;
  }
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return;
  }
  if (
    !isRecord(v) ||
    v.schema !== TIMING_SCHEMA ||
    !id(v.trace, 32) ||
    !id(v.span, 16) ||
    !(v.parent === undefined || v.parent === null || id(v.parent, 16)) ||
    v.parent === v.span ||
    !name(v.step) ||
    typeof v.proc !== "string" ||
    typeof v.clock !== "string" ||
    typeof v.outcome !== "string" ||
    (v.cached !== undefined && (v.cached !== true || v.outcome !== "ok")) ||
    (v.attrs !== undefined && !isRecord(v.attrs)) ||
    !number(v.origin_unix_us) ||
    !number(v.origin_mono_us) ||
    !number(v.start_us) ||
    !number(v.dur_us) ||
    !number(v.start_us + v.dur_us)
  ) {
    return;
  }
  const attrs: TimingRecord["attrs"] = {};
  if (isRecord(v.attrs)) {
    for (const [key, value] of Object.entries(v.attrs)) {
      if (
        name(key) &&
        (typeof value === "boolean" ||
          (typeof value === "number" &&
            Number.isFinite(value) &&
            Math.abs(value) <= Number.MAX_SAFE_INTEGER))
      ) {
        attrs[key] = value;
      }
    }
  }
  return {
    schema: TIMING_SCHEMA,
    trace: v.trace,
    span: v.span,
    parent: v.parent ?? null,
    proc: known(v.proc, ["cli", "runtime", "owner", "guest"]),
    clock: known(v.clock, ["host", "guest"]),
    origin_unix_us: v.origin_unix_us,
    origin_mono_us: v.origin_mono_us,
    step: v.step,
    start_us: v.start_us,
    dur_us: v.dur_us,
    outcome: known(v.outcome, [
      "ok",
      "error",
      "cancelled",
      "incomplete",
      "skipped",
    ]),
    ...(v.cached && { cached: v.cached }),
    ...(name(v.code) ? { code: v.code } : {}),
    attrs,
  };
}
