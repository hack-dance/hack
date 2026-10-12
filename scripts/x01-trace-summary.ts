// TEMPORARY X01 measurement summary. Reverted before the final commit.
// Reads closed-label JSONL written by src/lib/x01-cost-probe.ts.
type Event = {
  readonly p: number;
  readonly v: string;
  readonly k: string;
  readonly s?: string;
  readonly l?: string;
  readonly ms?: number;
  readonly t?: number;
  readonly c?: number;
  readonly line?: {
    readonly phase?: string;
    readonly boundary?: string;
    readonly durationMs?: number | null;
  };
};
const WITNESS = new Set([
  "storage-prepare",
  "storage-verify",
  "carrier-new",
  "inspect",
  "provision",
  "finish",
  "witness-verify",
  "witness-prepare",
  "witness-enroll",
]);
const isWitness = (label: string) =>
  WITNESS.has(label) || label.startsWith("invoke:");
// TEMPORARY X04: direct engine-ID reads (`ident:direct`, `ident:admission`) are leaves too.
const LEAF = new Set(["probe", "run", "exec", "hash", "ident"]);
const PHASE = /^(oneoff|storage|guard|finish|finalize)\.[a-z-]+$/;

const path = process.argv[2];
const title = process.argv[3] ?? path;
if (!path) {
  throw new Error("usage: x01-trace-summary <file> [title]");
}
const text = await Bun.file(path).text();
const events: Event[] = [];
for (const line of text.split("\n")) {
  if (line.trim() === "") {
    continue;
  }
  try {
    events.push(JSON.parse(line) as Event);
  } catch {
    // skip partial line
  }
}
const byProcess = new Map<number, Event[]>();
for (const event of events) {
  const list = byProcess.get(event.p) ?? [];
  list.push(event);
  byProcess.set(event.p, list);
}
type Proc = {
  readonly pid: number;
  readonly verb: string;
  readonly totalMs: number;
  readonly witnessMs: number;
  readonly events: Event[];
  readonly kind: string;
};
function topWitnessMs(list: Event[]): number {
  let total = 0;
  for (const event of list) {
    if (event.k !== "scope" || !event.l || !isWitness(event.l)) {
      continue;
    }
    const parts = (event.s ?? "").split(">");
    parts.pop();
    if (parts.some(isWitness)) {
      continue;
    }
    total += event.ms ?? 0;
  }
  return total;
}
const procs: Proc[] = [];
for (const [pid, list] of byProcess) {
  const exit = list.find((event) => event.k === "exit");
  const verb = list[0]?.v ?? "other";
  const labels = new Set(list.map((event) => event.l ?? ""));
  let kind = verb;
  if (verb === "up" || verb === "restart" || verb === "run") {
    if (labels.has("invoke:seed")) {
      kind = `${verb}(cold)`;
    } else if (labels.has("invoke:verify")) {
      kind = `${verb}(warm)`;
    } else {
      kind = `${verb}(no-witness)`;
    }
  } else if (verb === "exec") {
    kind = labels.has("invoke:verify") ? "exec(storage)" : "exec(image)";
  }
  procs.push({
    pid,
    verb,
    totalMs: exit?.t ?? Math.max(...list.map((event) => event.t ?? 0)),
    witnessMs: topWitnessMs(list),
    events: list,
    kind,
  });
}
const fmt = (ms: number) => (ms / 1000).toFixed(1);
const out: string[] = [];
out.push(`#### X01 trace: ${title}`);
out.push(`events=${events.length} processes=${procs.length}`);
out.push("");
out.push(
  "kind | n | avg total s | sum total s | avg witness s | sum witness s"
);
const kinds = [...new Set(procs.map((proc) => proc.kind))].sort();
for (const kind of kinds) {
  const selected = procs.filter((proc) => proc.kind === kind);
  const total = selected.reduce((sum, proc) => sum + proc.totalMs, 0);
  const witness = selected.reduce((sum, proc) => sum + proc.witnessMs, 0);
  out.push(
    `${kind} | ${selected.length} | ${fmt(total / selected.length)} | ${fmt(total)} | ${fmt(witness / selected.length)} | ${fmt(witness)}`
  );
}
const allTotal = procs.reduce((sum, proc) => sum + proc.totalMs, 0);
const allWitness = procs.reduce((sum, proc) => sum + proc.witnessMs, 0);
out.push(
  `ALL | ${procs.length} | - | ${fmt(allTotal)} | - | ${fmt(allWitness)}`
);
out.push("");
// TEMPORARY X04: engine-ID admissions by selection kind and outcome.
const admissions = new Map<string, number>();
for (const event of events) {
  if (event.k === "ident-admit" && event.l) {
    admissions.set(event.l, (admissions.get(event.l) ?? 0) + 1);
  }
}
out.push(
  `ident admissions: ${
    [...admissions.entries()]
      .sort()
      .map(([label, count]) => `${label}=${count}`)
      .join(" ") || "none"
  }`
);
out.push("");

function leafTable(selected: Proc[], heading: string, limit = 24) {
  const rows = new Map<string, { n: number; ms: number }>();
  for (const proc of selected) {
    for (const event of proc.events) {
      if (!(LEAF.has(event.k) && event.l)) {
        continue;
      }
      const key = `${event.k}:${event.l}`;
      const row = rows.get(key) ?? { n: 0, ms: 0 };
      row.n += 1;
      row.ms += event.ms ?? 0;
      rows.set(key, row);
    }
  }
  out.push(`${heading} (per process avg over n=${selected.length})`);
  out.push("leaf | calls/proc | s/proc | ms/call");
  const sorted = [...rows.entries()].sort((a, b) => b[1].ms - a[1].ms);
  for (const [key, row] of sorted.slice(0, limit)) {
    out.push(
      `${key} | ${(row.n / selected.length).toFixed(1)} | ${fmt(row.ms / selected.length)} | ${(row.ms / row.n).toFixed(0)}`
    );
  }
  out.push("");
}
function leafByScope(selected: Proc[], heading: string, limit = 40) {
  const rows = new Map<string, { n: number; ms: number }>();
  for (const proc of selected) {
    for (const event of proc.events) {
      if (!(LEAF.has(event.k) && event.l)) {
        continue;
      }
      const parts = (event.s ?? "")
        .split(">")
        .filter(
          (part) =>
            isWitness(part) || part.startsWith("cmd:") || PHASE.test(part)
        );
      const inner = parts.slice(-2).join(">") || "(none)";
      const key = `${inner} :: ${event.k}:${event.l}`;
      const row = rows.get(key) ?? { n: 0, ms: 0 };
      row.n += 1;
      row.ms += event.ms ?? 0;
      rows.set(key, row);
    }
  }
  out.push(
    `${heading} leaves by scope (per process avg over n=${selected.length})`
  );
  out.push("scope :: leaf | calls/proc | s/proc | ms/call");
  const sorted = [...rows.entries()].sort((a, b) => b[1].ms - a[1].ms);
  for (const [key, row] of sorted.slice(0, limit)) {
    out.push(
      `${key} | ${(row.n / selected.length).toFixed(1)} | ${fmt(row.ms / selected.length)} | ${(row.ms / row.n).toFixed(0)}`
    );
  }
  out.push("");
}
function scopeTable(selected: Proc[], heading: string, limit = 30) {
  const rows = new Map<string, { n: number; ms: number }>();
  for (const proc of selected) {
    for (const event of proc.events) {
      if (event.k !== "scope" || !event.l) {
        continue;
      }
      const parts = (event.s ?? "").split(">");
      const key = parts
        .filter(
          (part) =>
            PHASE.test(part) ||
            isWitness(part) ||
            part.startsWith("xattr:") ||
            part.startsWith("cmd:") ||
            part.startsWith("exec-")
        )
        .join(">");
      if (key === "") {
        continue;
      }
      const row = rows.get(key) ?? { n: 0, ms: 0 };
      row.n += 1;
      row.ms += event.ms ?? 0;
      rows.set(key, row);
    }
  }
  out.push(`${heading} scopes (per process avg over n=${selected.length})`);
  out.push("scope path | n/proc | s/proc | ms/each");
  const sorted = [...rows.entries()].sort((a, b) => b[1].ms - a[1].ms);
  for (const [key, row] of sorted.slice(0, limit)) {
    out.push(
      `${key} | ${(row.n / selected.length).toFixed(1)} | ${fmt(row.ms / selected.length)} | ${(row.ms / row.n).toFixed(0)}`
    );
  }
  out.push("");
}
function phaseRows(proc: Proc) {
  const rows = new Map<string, { n: number; ms: number }>();
  for (const event of proc.events) {
    if (
      event.k === "phase" &&
      event.line?.boundary !== "begin" &&
      event.line?.phase
    ) {
      const row = rows.get(event.line.phase) ?? { n: 0, ms: 0 };
      row.n += 1;
      row.ms += event.line.durationMs ?? 0;
      rows.set(event.line.phase, row);
    }
  }
  return rows;
}
for (const kind of [
  "up(cold)",
  "up(warm)",
  "exec(storage)",
  "restart(warm)",
  "run(warm)",
  "run(cold)",
  "down",
]) {
  const selected = procs.filter((proc) => proc.kind === kind);
  if (selected.length === 0) {
    continue;
  }
  const sample = selected[0] as Proc;
  out.push(
    `### ${kind}: first sample total ${fmt(sample.totalMs)} s, witness ${fmt(sample.witnessMs)} s`
  );
  out.push("phase-trace phase | spans | s");
  for (const [phase, row] of phaseRows(sample)) {
    out.push(`${phase} | ${row.n} | ${fmt(row.ms)}`);
  }
  out.push("");
  scopeTable([sample], `${kind} first sample`, 40);
  leafTable([sample], `${kind} first sample leaves`);
  scopeTable(selected, `${kind} all`, 30);
  leafTable(selected, `${kind} all leaves`);
  leafByScope(selected, `${kind} all`);
}
console.log(out.join("\n"));
