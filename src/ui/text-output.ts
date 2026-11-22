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

export type TableCell =
  | string
  | { readonly text: string; readonly role: Role }
  | null;

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

const LINE_BREAKS = /[\r\n\u0085\u2028\u2029]+/g;
const CONTROL_CHARACTERS = /\p{Cc}/gu;

function singleLine(text: string): string {
  return Bun.stripANSI(text)
    .replaceAll(LINE_BREAKS, " ")
    .replaceAll("\t", " ")
    .replaceAll(CONTROL_CHARACTERS, "");
}

function requireCommand(command: string): void {
  if (command.trim().length === 0 || singleLine(command) !== command) {
    throw new Error("Expected a non-empty, single-line command");
  }
}

function cellText(cell: TableCell): string {
  const text = typeof cell === "string" ? cell : (cell?.text ?? "-");
  return singleLine(text);
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

  function writeRenderedLine(text: string): void {
    write(`${text}\n`);
  }

  function line(text = "", role: Role = "ink"): void {
    writeRenderedLine(paint(singleLine(text), role));
  }

  return {
    line,
    /**
     * Reserve widths before the first completed row. Print late or wider
     * fields in full, shifting subsequent cells in that row only.
     */
    stepRows(
      rows: readonly Pick<StepRow, "name" | "detail">[],
      { markGap = 1 } = {}
    ) {
      let nameWidth = 0;
      let detailWidth = 0;
      for (const row of rows) {
        nameWidth = Math.max(nameWidth, width(singleLine(row.name)));
        detailWidth = Math.max(
          detailWidth,
          width(singleLine(row.detail ?? ""))
        );
      }
      return (row: StepRow): void => {
        const { status, result } = row;
        const name = singleLine(row.name);
        const detail = singleLine(row.detail ?? "");
        const { mark, role } = stepMarks[status];
        const heading = `${paint(mark, role)}${" ".repeat(markGap)}${name}`;
        const details = detail ? paint(detail, "dim") : "";
        const between = "  ";
        if (result) {
          const detailColumn =
            detailWidth > 0 || detail
              ? `${details}${pad(detail, detailWidth)}${between}`
              : "";
          writeRenderedLine(
            `${heading}${pad(name, nameWidth)}${between}${detailColumn}${paint(singleLine(result), "faint")}`
          );
        } else if (details) {
          writeRenderedLine(
            `${heading}${pad(name, nameWidth)}${between}${details}`
          );
        } else {
          writeRenderedLine(heading);
        }
      };
    },
    /**
     * Size columns from all rows before writing the header. Cells retain their
     * contents at narrow terminal widths so commands and addresses stay copyable.
     */
    table(input: {
      readonly columns: readonly string[];
      readonly rows: readonly (readonly TableCell[])[];
      readonly count?: string;
    }): void {
      const headings = input.columns.map((column) =>
        cellText(column).toUpperCase()
      );
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
        writeRenderedLine(cells.join("  "));
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
      readonly needs?: string;
      readonly command?: string;
      /** Optional fourth line, printed only when stdout is a TTY. */
      readonly prompt?: string;
    }): void {
      const which = input.which ? ` (${singleLine(input.which)})` : "";
      writeRenderedLine(
        `${paint("!", "attention")} ${singleLine(input.thing)}  ${singleLine(input.problem)}${which}`
      );
      if (input.command !== undefined) {
        if (
          input.command.trim() &&
          singleLine(input.command) === input.command
        ) {
          line(`  ${input.needs}. run:`);
          line(`  ${input.command}`);
        } else {
          line("  recovery command could not be printed on one line", "faint");
        }
      }
      if (tty && input.prompt) {
        line(`  ${input.prompt}`, "faint");
      }
    },
    hint(input: { readonly text: string; readonly command: string }): void {
      requireCommand(input.command);
      line(`${singleLine(input.text).toLowerCase()} ${input.command}`, "faint");
    },
  };
}
