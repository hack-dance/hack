import { createTextOutput, type TableCell } from "./text-output.ts";

export type PsRow = {
  readonly service: string;
  readonly state: string;
  readonly address: string | null;
  readonly container?: string | null;
  readonly exitCode?: number | null;
  readonly ports?: string | null;
  readonly remote?: {
    readonly kind: string;
    readonly use: string;
    readonly pointsAt: string;
    readonly via: string;
  };
};

export function psServiceState(item: {
  readonly state: string;
  readonly health?: string | null;
  readonly exitCode?: number | null;
}): string {
  const state = item.state.toLowerCase() || "unknown";
  if (state === "exited" && item.exitCode != null) {
    return `exited (${item.exitCode})`;
  }
  return state === "running" ? item.health?.toLowerCase() || state : state;
}

export function renderPs(input: {
  readonly rows: readonly PsRow[];
  readonly wide?: boolean;
  readonly hasRemotes?: boolean;
  readonly hintWhenEmpty?: boolean;
  readonly output?: ReturnType<typeof createTextOutput>;
}): void {
  const output = input.output ?? createTextOutput();
  const columns = input.hasRemotes
    ? ["service", "kind", "use", "points at", "via", "state"]
    : ["service", "address", "state"];
  if (input.wide) {
    columns.push("container", "exit code", "ports");
  }
  const rows = input.rows.map((row) => {
    const address = row.address
      ? { text: row.address, role: "identity" as const }
      : { text: "no address", role: "faint" as const };
    const cells: TableCell[] = input.hasRemotes
      ? [
          row.service,
          row.remote?.kind ?? "local",
          row.remote?.use ?? null,
          row.remote?.pointsAt ?? row.address,
          row.remote?.via ?? null,
          row.state,
        ]
      : [row.service, address, row.state];
    if (input.wide) {
      cells.push(
        row.container ?? null,
        row.exitCode?.toString() ?? null,
        row.ports ?? null
      );
    }
    return cells;
  });
  const count = rows.length;
  output.table({
    columns,
    rows,
    count: `${count} service${count === 1 ? "" : "s"}`,
  });
  if (count === 0 && input.hintWhenEmpty) {
    output.hint({ text: "nothing running. try:", command: "hack up" });
  }
}
