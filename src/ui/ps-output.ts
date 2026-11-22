import { createTextOutput, type TableCell } from "./text-output.ts";

export type PsRow = {
  readonly service: string;
  readonly state: string;
  readonly address: string | null;
  readonly addresses?: readonly string[];
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

function psAddressText(row: PsRow, wide?: boolean): string | undefined {
  const addresses = row.addresses ?? (row.address ? [row.address] : []);
  if (wide) {
    return addresses.join(", ");
  }
  const first = addresses[0];
  return first && addresses.length > 1
    ? `${first} +${addresses.length - 1}`
    : first;
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
  const totals = new Map<string, number>();
  const replicas = new Map<string, number>();
  for (const row of input.rows) {
    totals.set(row.service, (totals.get(row.service) ?? 0) + 1);
  }
  const rows = input.rows.map((row) => {
    const n = (replicas.get(row.service) ?? 0) + 1;
    replicas.set(row.service, n);
    const total = totals.get(row.service) ?? 1;
    const service = total > 1 ? `${row.service} (${n}/${total})` : row.service;
    const addressText = psAddressText(row, input.wide);
    const address = addressText
      ? { text: addressText, role: "identity" as const }
      : { text: "no address", role: "faint" as const };
    const cells: TableCell[] = input.hasRemotes
      ? [
          service,
          row.remote?.kind ?? "local",
          row.remote?.use ?? null,
          row.remote?.pointsAt ?? addressText ?? null,
          row.remote?.via ?? null,
          row.state,
        ]
      : [service, address, row.state];
    if (input.wide) {
      cells.push(
        row.container ?? null,
        row.exitCode?.toString() ?? null,
        row.ports ?? null
      );
    }
    return cells;
  });
  const count = totals.size;
  output.table({
    columns,
    rows,
    count: `${count} service${count === 1 ? "" : "s"}`,
  });
  if (count === 0 && input.hintWhenEmpty) {
    output.hint({ text: "nothing running. try:", command: "hack up" });
  }
}
