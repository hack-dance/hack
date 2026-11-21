import { isColorEnabled, isTty } from "./terminal.ts";

const roles = {
  ink: "",
  dim: "\x1b[2m",
  faint: "\x1b[2;90m",
  attention: "\x1b[33m",
  identity: "\x1b[36m",
} as const;

type Role = keyof typeof roles;

export type StepStatus = "ok" | "warn" | "error" | "info";
export type StepRow = {
  readonly name: string;
  readonly status: StepStatus;
  readonly detail?: string;
  readonly result?: string;
};

type TableCell = string | { readonly text: string; readonly role: Role } | null;

const stepMarks = {
  ok: { mark: "✓", role: "identity" },
  warn: { mark: "!", role: "attention" },
  error: { mark: "×", role: "attention" },
  info: { mark: "•", role: "ink" },
} as const;

function width(text: string): number {
  return Bun.stringWidth(text);
}

function pad(text: string, columns: number): string {
  return " ".repeat(Math.max(0, columns - width(text)));
}

function cellText(cell: TableCell): string {
  const text = typeof cell === "string" ? cell : (cell?.text ?? "-");
  return text.replaceAll(/[\r\n\t]/g, " ");
}

export function formatDuration(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)}s`;
}

/** Direct terminal text. Capture output capabilities once for each group. */
export function createTextOutput({
  color = isColorEnabled(),
  tty = isTty(),
  write = (line: string) => process.stdout.write(line),
}: {
  readonly color?: boolean;
  readonly tty?: boolean;
  readonly write?: (text: string) => void;
} = {}) {
  function paint(text: string, role: Role): string {
    const style = roles[role];
    return color && tty && style && text ? `${style}${text}\x1b[0m` : text;
  }

  function line(text = "", role: Role = "ink"): void {
    write(`${paint(text, role)}\n`);
  }

  return {
    line,
    /** Measure names and details before emitting the first completed row. */
    stepRows(
      rows: readonly Pick<StepRow, "name" | "detail">[],
      { markGap = 1 } = {}
    ) {
      let nameWidth = 0;
      let detailWidth = 0;
      for (const row of rows) {
        nameWidth = Math.max(nameWidth, width(row.name));
        detailWidth = Math.max(detailWidth, width(row.detail ?? ""));
      }
      return ({ status, name, detail = "", result }: StepRow): void => {
        const { mark, role } = stepMarks[status];
        const heading = `${paint(mark, role)}${" ".repeat(markGap)}${name}`;
        const details = detail ? paint(detail, "dim") : "";
        const between = "  ";
        if (result) {
          const detailColumn = detailWidth
            ? `${details}${pad(detail, detailWidth)}${between}`
            : "";
          line(
            `${heading}${pad(name, nameWidth)}${between}${detailColumn}${paint(result, "faint")}`
          );
        } else if (details) {
          line(`${heading}${pad(name, nameWidth)}${between}${details}`);
        } else {
          line(heading);
        }
      };
    },
    table(input: {
      readonly columns: readonly string[];
      readonly rows: readonly (readonly TableCell[])[];
      readonly count?: string;
    }): void {
      const headings = input.columns.map((column) => column.toUpperCase());
      const widths = headings.map((heading, index) =>
        input.rows.reduce(
          (maximum, row) =>
            Math.max(maximum, width(cellText(row[index] ?? null))),
          width(heading)
        )
      );
      function renderRow(row: readonly TableCell[], role: Role): void {
        const cells = widths.map((columns, index) => {
          const cell = row[index] ?? null;
          const text = cellText(cell);
          const styled = paint(
            text,
            typeof cell === "object" && cell ? cell.role : role
          );
          return index === widths.length - 1
            ? styled
            : `${styled}${pad(text, columns)}`;
        });
        line(cells.join("  "));
      }
      renderRow(headings, "faint");
      for (const row of input.rows) {
        renderRow(row, "ink");
      }
      if (input.count) {
        line();
        line(input.count, "faint");
      }
    },
    blocker(input: {
      readonly thing: string;
      readonly problem: string;
      readonly which?: string;
      readonly needs: string;
      readonly command: string;
      readonly prompt?: string;
    }): void {
      const which = input.which ? ` (${input.which})` : "";
      line(
        `${paint("!", "attention")} ${input.thing}  ${input.problem}${which}`
      );
      line(`  ${input.needs}. run: ${input.command}`);
      if (tty && input.prompt) {
        line(`  ${input.prompt}`, "faint");
      }
    },
    hint(text: string): void {
      line(text, "faint");
    },
  };
}
