/** Bun versions expose CPU counters as either numbers or bigints despite older type declarations. */
export function readSubprocessResourceUsage(
  proc: Pick<Bun.Subprocess, "resourceUsage">
): { cpuTimeMs: number | null; maxRssBytes: number | null } {
  try {
    const usage = proc.resourceUsage();
    if (!usage) {
      return { cpuTimeMs: null, maxRssBytes: null };
    }
    const cpuTimeMs = Number(usage.cpuTime.total) / 1000;
    // Bun 1.3 exposes native ru_maxrss (KiB on Linux); Bun 1.4 normalizes to bytes.
    const rssScale =
      process.platform === "linux" &&
      Bun.semver.satisfies(Bun.version, "<1.4.0")
        ? 1024
        : 1;
    const maxRssBytes = Number(usage.maxRSS) * rssScale;
    return {
      cpuTimeMs: Number.isFinite(cpuTimeMs) ? cpuTimeMs : null,
      maxRssBytes: Number.isFinite(maxRssBytes) ? maxRssBytes : null,
    };
  } catch {
    return { cpuTimeMs: null, maxRssBytes: null };
  }
}
