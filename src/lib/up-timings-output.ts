import type { TimingRecord } from "./timing-record.ts";

type Milestone = readonly [step: string, label: string];

const UP_MILESTONES: readonly Milestone[] = [
  ["containers.started", "All containers started"],
  ["services.ready", "All services ready"],
];

/**
 * Print a joined `hack.timings/1` timeline to stderr. Only host-clock records
 * with a trusted anchor are placed; stdout stays reserved for command output.
 */
export function printCommandTimeline(
  records: readonly TimingRecord[],
  title: string,
  milestones: readonly Milestone[] = []
): void {
  const root = records.find((record) => record.step === "command.total");
  if (!root) {
    return;
  }
  const offset = (record: TimingRecord) =>
    record.origin_mono_us + record.start_us - root.origin_mono_us;
  const host = records.filter(
    (record) => record.clock === "host" && record.attrs.anchor_fresh !== true
  );
  const ms = (us: number) => `${(us / 1000).toFixed(1)} ms`;
  const lines = [`${title} (${ms(root.dur_us)})`];
  for (const [step, label] of milestones) {
    const milestone = host.find(
      (record) => record.step === step && record.outcome === "ok"
    );
    lines.push(
      `  ${label}: ${milestone ? ms(offset(milestone) + milestone.dur_us) : "not observed"}`
    );
  }
  for (const record of host.sort((a, b) => offset(a) - offset(b))) {
    if (record !== root) {
      lines.push(
        `  +${ms(offset(record))}  ${record.step}  ${ms(record.dur_us)}  ${record.outcome}`
      );
    }
  }
  process.stderr.write(`${lines.join("\n")}\n`);
}

export function printUpTimings(records: readonly TimingRecord[]): void {
  printCommandTimeline(records, "Startup timeline", UP_MILESTONES);
}
