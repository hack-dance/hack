import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EnvHydrateInputError,
  type EnvHydrateInputRefusalReason,
  parseEnvHydrateInput,
  parseEnvHydrateInputFormat,
  readEnvHydrateInput,
} from "../src/lib/env-hydrate-input.ts";

/**
 * HACK-1158: hydration input is parsed strictly and all-or-nothing, and every
 * refusal is value-free. CANARY is a synthetic string that must never reach
 * an error message.
 */

const CANARY = "synthetic-canary-7d41";

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

function entriesOf(text: string, format: "env" | "json" = "env") {
  return Object.fromEntries(parseEnvHydrateInput({ text, format }));
}

function refusal(run: () => unknown): {
  reason: EnvHydrateInputRefusalReason;
  line: number | null;
} {
  try {
    run();
  } catch (error: unknown) {
    if (!(error instanceof EnvHydrateInputError)) {
      throw error;
    }
    expect(error.message).not.toContain(CANARY);
    expect(error.message).toContain("Nothing was written.");
    return { reason: error.reason, line: error.line };
  }
  throw new Error("Expected a hydration input refusal");
}

async function asyncRefusal(
  run: () => Promise<unknown>
): Promise<EnvHydrateInputRefusalReason> {
  try {
    await run();
  } catch (error: unknown) {
    if (!(error instanceof EnvHydrateInputError)) {
      throw error;
    }
    expect(error.message).not.toContain(CANARY);
    return error.reason;
  }
  throw new Error("Expected a hydration input refusal");
}

function stdinOf(bytes: Uint8Array, isTTY = false) {
  return {
    isTTY,
    open: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
  };
}

test("env format accepts comments, export, quotes and literal #", () => {
  expect(
    entriesOf(
      [
        "# source: synthetic fixture",
        "",
        "API_TOKEN=plain-value",
        "  export DB_PASS = 'single # quoted'  # trailing comment",
        'MULTI="line\\none\\t\\"q\\" \\\\"',
        "HASH=abc#def",
        "SPACED=  inner value  ",
        "CRLF=value\r",
      ].join("\n")
    )
  ).toEqual({
    API_TOKEN: "plain-value",
    DB_PASS: "single # quoted",
    MULTI: 'line\none\t"q" \\',
    HASH: "abc#def",
    SPACED: "inner value",
    CRLF: "value",
  });
});

test("json format accepts one object of string values", () => {
  expect(
    entriesOf(JSON.stringify({ API_TOKEN: CANARY, DB_PASS: "b" }), "json")
  ).toEqual({ API_TOKEN: CANARY, DB_PASS: "b" });
});

test("each malformed env line refuses the whole input with its line number", () => {
  const cases: readonly [string, EnvHydrateInputRefusalReason, number][] = [
    [`OK=1\n${CANARY}`, "invalid_line", 2],
    [`OK=1\n=${CANARY}`, "invalid_line", 2],
    [`lower_${CANARY}=x`, "invalid_key", 1],
    [`API_TOKEN=${CANARY}\nAPI_TOKEN=${CANARY}`, "duplicate_key", 2],
    ["API_TOKEN=", "empty_value", 1],
    ["API_TOKEN=''", "empty_value", 1],
    [`API_TOKEN='${CANARY}`, "unterminated_quote", 1],
    [`API_TOKEN="${CANARY}\nrest"`, "unterminated_quote", 1],
    [`API_TOKEN="${CANARY}\\x"`, "invalid_escape", 1],
    [`API_TOKEN='${CANARY}' ${CANARY}`, "trailing_text", 1],
  ];
  for (const [text, reason, line] of cases) {
    expect(refusal(() => entriesOf(text))).toEqual({ reason, line });
  }
});

test("empty input and malformed json are refused without echo", () => {
  expect(refusal(() => entriesOf("# only comments\n\n")).reason).toBe("empty");
  const jsonCases: readonly [string, EnvHydrateInputRefusalReason][] = [
    [`{"API_TOKEN": ${CANARY}}`, "invalid_json"],
    [`["${CANARY}"]`, "json_not_object"],
    [`"${CANARY}"`, "json_not_object"],
    [`{"bad-${CANARY}": "x"}`, "invalid_key"],
    ['{"API_TOKEN": 7}', "json_value_not_string"],
    ['{"API_TOKEN": ""}', "empty_value"],
    ["{}", "empty"],
  ];
  for (const [text, reason] of jsonCases) {
    expect(refusal(() => entriesOf(text, "json")).reason).toBe(reason);
  }
});

test("--format accepts only env and json and never echoes the argument", () => {
  expect(parseEnvHydrateInputFormat(undefined)).toBe("env");
  expect(parseEnvHydrateInputFormat("json")).toBe("json");
  expect(refusal(() => parseEnvHydrateInputFormat(CANARY)).reason).toBe(
    "invalid_format"
  );
});

test("stdin input is bounded and refuses TTY, NUL and invalid UTF-8", async () => {
  const encoder = new TextEncoder();
  expect(
    Object.fromEntries(
      await readEnvHydrateInput({
        format: "env",
        stdin: stdinOf(encoder.encode(`API_TOKEN=${CANARY}\n`)),
      })
    )
  ).toEqual({ API_TOKEN: CANARY });
  let opened = false;
  expect(
    await asyncRefusal(() =>
      readEnvHydrateInput({
        format: "env",
        stdin: {
          isTTY: true,
          open: () => {
            opened = true;
            throw new Error("must not read a TTY");
          },
        },
      })
    )
  ).toBe("interactive_tty");
  expect(opened).toBe(false);
  expect(
    await asyncRefusal(() =>
      readEnvHydrateInput({
        format: "env",
        stdin: stdinOf(encoder.encode(`API_TOKEN=${CANARY}`)),
        maxBytes: 8,
      })
    )
  ).toBe("oversize");
  expect(
    await asyncRefusal(() =>
      readEnvHydrateInput({
        format: "env",
        stdin: stdinOf(encoder.encode(`API_TOKEN=${CANARY}\0`)),
      })
    )
  ).toBe("nul_byte");
  expect(
    await asyncRefusal(() =>
      readEnvHydrateInput({
        format: "env",
        stdin: stdinOf(new Uint8Array([0x41, 0x3d, 0xff, 0xfe])),
      })
    )
  ).toBe("invalid_utf8");
});

test("file input reads regular files and refuses directories and missing paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hack-hydrate-input-"));
  tempDirs.add(dir);
  const file = join(dir, "entries.env");
  await writeFile(file, `API_TOKEN=${CANARY}\n`);
  expect(
    Object.fromEntries(
      await readEnvHydrateInput({ format: "env", filePath: file })
    )
  ).toEqual({ API_TOKEN: CANARY });
  expect(
    await asyncRefusal(() =>
      readEnvHydrateInput({ format: "env", filePath: dir })
    )
  ).toBe("read_failed");
  expect(
    await asyncRefusal(() =>
      readEnvHydrateInput({
        format: "env",
        filePath: join(dir, `missing-${CANARY}`),
      })
    )
  ).toBe("read_failed");
  expect(
    await asyncRefusal(() =>
      readEnvHydrateInput({ format: "env", filePath: file, maxBytes: 4 })
    )
  ).toBe("oversize");
});
