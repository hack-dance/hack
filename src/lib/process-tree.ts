export type ProcessIdentityRow = {
  readonly pid: number;
  readonly parentPid: number;
  readonly birth: string;
};
const IDENTITY_ROW = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/;

/** Capture only process identity and lineage; never command arguments or environment. */
export async function readProcessIdentities(): Promise<ProcessIdentityRow[]> {
  try {
    const proc = Bun.spawn(["ps", "-A", "-o", "pid=,ppid=,lstart="], {
      env: { ...process.env, LC_ALL: "C" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 2000,
    });
    const output = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) {
      return [];
    }
    return output.split("\n").flatMap((line) => {
      const match = IDENTITY_ROW.exec(line);
      return match
        ? [
            {
              pid: Number(match[1]),
              parentPid: Number(match[2]),
              birth: (match[3] ?? "").replace(/\s+/g, " "),
            },
          ]
        : [];
    });
  } catch {
    return [];
  }
}

export function selectProcessTree(
  rows: readonly ProcessIdentityRow[],
  rootPid: number
): ProcessIdentityRow[] {
  const children = new Map<number, ProcessIdentityRow[]>();
  for (const row of rows) {
    const entries = children.get(row.parentPid) ?? [];
    entries.push(row);
    children.set(row.parentPid, entries);
  }
  const root = rows.find((row) => row.pid === rootPid);
  const tree = root ? [root] : [];
  const seen = new Set([rootPid]);
  for (const parent of tree) {
    for (const child of children.get(parent.pid) ?? []) {
      if (!seen.has(child.pid)) {
        seen.add(child.pid);
        tree.push(child);
      }
    }
  }
  return tree;
}

/** Revalidate start times before signalling a captured tree, including reparented descendants. */
export async function signalVerifiedProcessTree(
  tree: readonly ProcessIdentityRow[],
  signal: NodeJS.Signals
): Promise<void> {
  if (!tree.length) {
    return;
  }
  const live = new Map(
    (await readProcessIdentities()).map((row) => [row.pid, row.birth])
  );
  for (const row of [...tree].reverse()) {
    if (live.get(row.pid) !== row.birth) {
      continue;
    }
    try {
      process.kill(row.pid, signal);
    } catch {
      /* Process already exited. */
    }
  }
}
