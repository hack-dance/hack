import type { TimingRecord } from "./timing-record.ts";

export function printUpTimings(records: readonly TimingRecord[]): void {
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
  const lines = [`Startup timeline (${ms(root.dur_us)})`];
  for (const [step, label] of [
    ["containers.started", "All containers started"],
    ["services.ready", "All services ready"],
  ] as const) {
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
