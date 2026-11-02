import { describe, expect, test } from "bun:test";

import { CliUsageError } from "../src/cli/command.ts";
import {
  assertEnvValueStdinUsage,
  ENV_VALUE_STDIN_MAX_BYTES,
  ENV_VALUE_STDIN_REFUSAL_REASONS,
  EnvValueStdinError,
  type EnvValueStdinSource,
  readEnvValueFromStdin,
  stripOneTrailingNewline,
} from "../src/lib/env-value-stdin.ts";

const SENTINEL = "stdin-sentinel-7f3a9c";

function sourceFrom(input: {
  readonly chunks: readonly (string | Uint8Array)[];
  readonly isTTY?: boolean;
}): EnvValueStdinSource & { opened: number } {
  const encoder = new TextEncoder();
  const state = {
    opened: 0,
    isTTY: input.isTTY ?? false,
    open: () => {
      state.opened += 1;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of input.chunks) {
            controller.enqueue(
              typeof chunk === "string" ? encoder.encode(chunk) : chunk
            );
          }
          controller.close();
        },
      });
    },
  };
  return state;
}

/** Never-ending producer: proves the reader stops at the bound. */
function endlessSource(): EnvValueStdinSource & {
  pulled: number;
  canceled: boolean;
} {
  const chunk = new TextEncoder().encode(SENTINEL.repeat(64));
  const state = {
    pulled: 0,
    canceled: false,
    isTTY: false,
    open: () =>
      new ReadableStream<Uint8Array>({
        pull(controller) {
          state.pulled += 1;
          controller.enqueue(chunk.slice());
        },
        cancel() {
          state.canceled = true;
        },
      }),
  };
  return state;
}

async function refusal(promise: Promise<unknown>): Promise<EnvValueStdinError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof EnvValueStdinError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a --value-stdin refusal");
}

/**
 * Leak detector shared by every refusal assertion: the caller's value (or any
 * fragment of it) must never appear in a diagnostic.
 */
function expectValueFree(error: unknown, value: string): void {
  const rendered =
    error instanceof Error
      ? `${error.name}\n${error.message}\n${error.stack ?? ""}\n${JSON.stringify(error)}`
      : String(error);
  for (const fragment of [value, value.slice(0, 8), value.slice(-8)]) {
    if (rendered.includes(fragment)) {
      throw new Error("diagnostic leaked caller input");
    }
  }
}

describe("readEnvValueFromStdin", () => {
  test("returns piped input unchanged when it has no trailing newline", async () => {
    const value = await readEnvValueFromStdin({
      source: sourceFrom({ chunks: [SENTINEL] }),
    });
    expect(value).toBe(SENTINEL);
  });

  test("strips exactly one trailing newline", async () => {
    expect(
      await readEnvValueFromStdin({
        source: sourceFrom({ chunks: [`${SENTINEL}\n`] }),
      })
    ).toBe(SENTINEL);
    expect(
      await readEnvValueFromStdin({
        source: sourceFrom({ chunks: [`${SENTINEL}\n\n`] }),
      })
    ).toBe(`${SENTINEL}\n`);
    expect(
      await readEnvValueFromStdin({
        source: sourceFrom({ chunks: [`${SENTINEL}\r\n`] }),
      })
    ).toBe(SENTINEL);
    expect(
      await readEnvValueFromStdin({
        source: sourceFrom({ chunks: ["line1\nline2\n"] }),
      })
    ).toBe("line1\nline2");
    expect(
      await readEnvValueFromStdin({
        source: sourceFrom({ chunks: [`  ${SENTINEL}  \n`] }),
      })
    ).toBe(`  ${SENTINEL}  `);
  });

  test("reassembles multi-byte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode("päss☃\n");
    const value = await readEnvValueFromStdin({
      source: sourceFrom({ chunks: [bytes.slice(0, 2), bytes.slice(2)] }),
    });
    expect(value).toBe("päss☃");
  });

  test("accepts input exactly at the byte bound", async () => {
    const value = await readEnvValueFromStdin({
      source: sourceFrom({ chunks: ["a".repeat(ENV_VALUE_STDIN_MAX_BYTES)] }),
    });
    expect(value.length).toBe(ENV_VALUE_STDIN_MAX_BYTES);
  });

  test("refuses oversize input with a closed error and stops reading", async () => {
    const endless = endlessSource();
    const error = await refusal(
      readEnvValueFromStdin({ source: endless, maxBytes: 4096 })
    );
    expect(error.reason).toBe("oversize");
    expect(error).toBeInstanceOf(CliUsageError);
    expect(endless.canceled).toBe(true);
    expect(endless.pulled).toBeLessThan(16);
    expectValueFree(error, SENTINEL);

    const atDefault = await refusal(
      readEnvValueFromStdin({
        source: sourceFrom({
          chunks: ["a".repeat(ENV_VALUE_STDIN_MAX_BYTES), "b"],
        }),
      })
    );
    expect(atDefault.reason).toBe("oversize");
  });

  test("refuses empty and newline-only input", async () => {
    for (const chunks of [[], [""], ["\n"], ["\r\n"]]) {
      const error = await refusal(
        readEnvValueFromStdin({ source: sourceFrom({ chunks }) })
      );
      expect(error.reason).toBe("empty");
    }
  });

  test("refuses an interactive TTY stdin before reading any byte", async () => {
    const source = sourceFrom({ chunks: [SENTINEL], isTTY: true });
    const error = await refusal(readEnvValueFromStdin({ source }));
    expect(error.reason).toBe("interactive_tty");
    expect(error.message).toContain("hidden prompt");
    expect(source.opened).toBe(0);
  });

  test("refuses invalid UTF-8 and NUL bytes without echoing input", async () => {
    const invalid = new Uint8Array([
      ...new TextEncoder().encode(SENTINEL),
      0xff,
      0xfe,
    ]);
    const utf8 = await refusal(
      readEnvValueFromStdin({ source: sourceFrom({ chunks: [invalid] }) })
    );
    expect(utf8.reason).toBe("invalid_utf8");
    expectValueFree(utf8, SENTINEL);

    const nul = await refusal(
      readEnvValueFromStdin({
        source: sourceFrom({ chunks: [`${SENTINEL}\0tail`] }),
      })
    );
    expect(nul.reason).toBe("nul_byte");
    expectValueFree(nul, SENTINEL);
  });

  test("maps read failures to a closed error that drops the cause", async () => {
    const source: EnvValueStdinSource = {
      isTTY: false,
      open: () =>
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.error(new Error(`backend said ${SENTINEL}`));
          },
        }),
    };
    const error = await refusal(readEnvValueFromStdin({ source }));
    expect(error.reason).toBe("read_failed");
    expect(error.cause).toBeUndefined();
    expectValueFree(error, SENTINEL);
  });
});

describe("assertEnvValueStdinUsage", () => {
  test("refuses a positional value and a missing key", () => {
    expect(() =>
      assertEnvValueStdinUsage({ hasKey: true, hasPositionalValue: true })
    ).toThrow(EnvValueStdinError);
    expect(() =>
      assertEnvValueStdinUsage({ hasKey: false, hasPositionalValue: false })
    ).toThrow(EnvValueStdinError);
    expect(() =>
      assertEnvValueStdinUsage({ hasKey: true, hasPositionalValue: false })
    ).not.toThrow();
  });
});

describe("refusal diagnostics", () => {
  test("every refusal message is fixed and value-free", () => {
    for (const reason of ENV_VALUE_STDIN_REFUSAL_REASONS) {
      const error = new EnvValueStdinError(reason);
      expect(error.message).toStartWith("--value-stdin");
      expect(error.message).toContain("Nothing was stored.");
      expectValueFree(error, SENTINEL);
    }
  });

  test("negative control: the leak detector catches a value in an error message", () => {
    const leaky = new CliUsageError(`Invalid value: ${SENTINEL}`);
    expect(() => expectValueFree(leaky, SENTINEL)).toThrow(
      "diagnostic leaked caller input"
    );
    const partial = new Error(`value starts with ${SENTINEL.slice(0, 8)}`);
    expect(() => expectValueFree(partial, SENTINEL)).toThrow(
      "diagnostic leaked caller input"
    );
  });
});

test("stripOneTrailingNewline removes at most one newline", () => {
  expect(stripOneTrailingNewline("a\n\n")).toBe("a\n");
  expect(stripOneTrailingNewline("a\r\n")).toBe("a");
  expect(stripOneTrailingNewline("a\r")).toBe("a\r");
  expect(stripOneTrailingNewline("a")).toBe("a");
});
