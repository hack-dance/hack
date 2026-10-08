import { fstatSync, type Stats, writeSync } from "node:fs";
import { readSubprocessResourceUsage } from "./process-resource-usage.ts";

/** An explicitly preopened empty private file, never a path or product prerequisite. */
export const NATIVE_CPU_REPORT_FD = "HACK_NATIVE_CPU_REPORT_FD";
const CHILD_LIMIT = 2048;
const REPORT_LIMIT = 512 * 1024;
const REPORT_FD = /^[1-9]\d{0,2}$/;
type CpuUsage = ReturnType<typeof readSubprocessResourceUsage>;
const NOOP = (_exitCode?: number): CpuUsage | undefined => undefined;
export type NativeCpuCategory = "compiler" | "docker" | "compose" | "other";
type ObservedChild = Pick<Bun.Subprocess, "resourceUsage">;
type CpuRecord = {
  readonly sequence: number;
  readonly category: NativeCpuCategory | "unclassified";
  readonly exitCode: number | null;
  readonly cpuTimeMs: number | null;
  readonly maxRssBytes: number | null;
};

function safeFile(info: Stats): boolean {
  return (
    info.isFile() &&
    info.uid === process.getuid?.() &&
    (info.mode & 0o7777) === 0o600 &&
    info.nlink === 1 &&
    info.size === 0
  );
}
function sameEmptyFile(left: Stats, right: Stats): boolean {
  return (
    safeFile(right) &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}
function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function validExit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function validCategory(value: unknown): value is NativeCpuCategory {
  return (
    value === "compiler" ||
    value === "docker" ||
    value === "compose" ||
    value === "other"
  );
}

/**
 * Passive observations for explicitly registered, reaped children. Completion
 * covers this registration matrix, not uninstrumented descendants or total
 * process-tree CPU. Independent accounting must verify those separately.
 * The caller retains its descriptor; failure never changes a command result.
 */
export function createNativeCpuCollector(fd: number) {
  if (!(Number.isInteger(fd) && fd >= 3 && fd <= 255)) {
    return null;
  }
  let anchor: Stats;
  try {
    anchor = fstatSync(fd);
    if (!safeFile(anchor)) {
      return null;
    }
  } catch {
    return null;
  }
  const children = new WeakSet<object>();
  const records: CpuRecord[] = [];
  let started = 0;
  let ended = 0;
  let duplicates = 0;
  let unclassified = 0;
  let missing = 0;
  let overflow = false;
  let closed = false;
  return {
    invalidate() {
      missing += 1;
    },
    begin(child: ObservedChild, category: NativeCpuCategory | null) {
      if (closed) {
        return NOOP;
      }
      if (children.has(child)) {
        duplicates += 1;
        return NOOP;
      }
      started += 1;
      if (started > CHILD_LIMIT) {
        overflow = true;
        return NOOP;
      }
      children.add(child);
      const sequence = started;
      const selected = validCategory(category) ? category : "unclassified";
      if (selected === "unclassified") {
        unclassified += 1;
      }
      let finished = false;
      return (exitCode?: number) => {
        if (closed) {
          return;
        }
        if (finished) {
          duplicates += 1;
          return;
        }
        finished = true;
        ended += 1;
        const usage = readSubprocessResourceUsage(child);
        const cpuTimeMs = validNumber(usage.cpuTimeMs) ? usage.cpuTimeMs : null;
        const maxRssBytes = validNumber(usage.maxRssBytes)
          ? usage.maxRssBytes
          : null;
        const code = validExit(exitCode) ? exitCode : null;
        if (cpuTimeMs === null || maxRssBytes === null || code === null) {
          missing += 1;
        }
        records.push({
          sequence,
          category: selected,
          exitCode: code,
          cpuTimeMs,
          maxRssBytes,
        });
        return usage;
      };
    },
    finish(exitCode?: number): boolean {
      if (closed) {
        return false;
      }
      closed = true;
      try {
        const self = process.cpuUsage();
        const selfUserMs = validNumber(self.user) ? self.user / 1000 : null;
        const selfSystemMs = validNumber(self.system)
          ? self.system / 1000
          : null;
        const report = JSON.stringify({
          version: 1,
          recordsComplete:
            !overflow &&
            duplicates === 0 &&
            unclassified === 0 &&
            missing === 0 &&
            started === ended &&
            selfUserMs !== null &&
            selfSystemMs !== null &&
            validExit(exitCode),
          exitCode: validExit(exitCode) ? exitCode : null,
          selfUserMs,
          selfSystemMs,
          started,
          ended,
          duplicates,
          unclassified,
          missing,
          overflow,
          records,
        });
        const bytes = Buffer.from(report);
        if (
          bytes.byteLength > REPORT_LIMIT ||
          !sameEmptyFile(anchor, fstatSync(fd))
        ) {
          return false;
        }
        // Exactly one final write to the caller's original empty capability.
        // Partial or absent reports never qualify; no path, truncate or retry.
        return (
          writeSync(fd, bytes, 0, bytes.byteLength, 0) === bytes.byteLength
        );
      } catch {
        return false;
      }
    },
  };
}

let active: ReturnType<typeof createNativeCpuCollector> = null;
let initialized = false;
export function initializeNativeCpuDiagnostics(): void {
  if (initialized) {
    return;
  }
  initialized = true;
  try {
    const selected = process.env[NATIVE_CPU_REPORT_FD];
    // This launch-only capability must not arm a nested CLI with a reused fd.
    delete process.env[NATIVE_CPU_REPORT_FD];
    if (selected && REPORT_FD.test(selected)) {
      active = createNativeCpuCollector(Number(selected));
    }
  } catch {
    // Diagnostics never turn an ordinary command into a refusal.
  }
}
export function beginNativeCpuChild(
  child: ObservedChild,
  category: NativeCpuCategory | null
): (exitCode?: number) => CpuUsage | undefined {
  try {
    return active?.begin(child, category) ?? NOOP;
  } catch {
    active?.invalidate();
    return NOOP;
  }
}
export function finishNativeCpuDiagnostics(exitCode?: number): void {
  try {
    active?.finish(exitCode);
  } catch {
    // Missing diagnostics never change the product's result or invoke cleanup.
  } finally {
    active = null;
  }
}
/** Only classify known command families; never retain an executable or argument. */
export function nativeCpuCommandCategory(
  command: readonly string[]
): NativeCpuCategory | null {
  const name = command[0]?.split("/").at(-1);
  if (name === "docker") {
    return command[1] === "compose" ? "compose" : "docker";
  }
  return name === "git" || name === "ps" || name === "sysctl" ? "other" : null;
}
