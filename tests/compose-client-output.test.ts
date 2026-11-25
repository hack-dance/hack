import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPOSE_CLIENT_FULL_OUTPUT_HINT,
  COMPOSE_CLIENT_PROMPT_HINT,
  composeClientWarnings,
  openComposeClientCapture,
  sanitizeComposeClientLines,
  tryOpenComposeClientCapture,
  writeComposeClientFailure,
  writeComposeClientTail,
  writeComposeClientWarnings,
} from "../src/lib/compose-client-output.ts";
import {
  composeEnvPlainValues,
  composeQuoteRedactValues,
} from "../src/lib/compose-ps-result.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hack-compose-client-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("the capture file is unlinked as soon as it opens", async () => {
  const capture = openComposeClientCapture(dir);
  try {
    expect(await readdir(dir)).toEqual([]);
    writeSync(capture.fd, "one\ntwo\n");
    expect(capture.tail()).toEqual(["one", "two"]);
  } finally {
    capture.close();
  }
  // A second close and a read after close are harmless.
  capture.close();
  expect(capture.tail()).toEqual([]);
  expect(capture.warnings()).toEqual([]);
});

test("an unusable temporary directory leaves the client's lines uncaptured", () => {
  expect(tryOpenComposeClientCapture(join(dir, "missing"))).toBeUndefined();
});

test("the tail keeps only the last lines and drops a partial first line", () => {
  const capture = openComposeClientCapture(dir);
  try {
    // One line longer than the 64 KiB window, so the window starts inside it.
    writeSync(capture.fd, `${"x".repeat(70_000)}\n`);
    for (let index = 1; index <= 30; index += 1) {
      writeSync(capture.fd, `line ${index}\n`);
    }
    const tail = capture.tail({ lines: 5 });
    expect(tail).toEqual([
      "line 26",
      "line 27",
      "line 28",
      "line 29",
      "line 30",
    ]);
    // The cut line is dropped rather than quoted in part.
    const all = capture.tail({ lines: 10_000 });
    expect(all[0]).toBe("line 1");
    expect(all).toHaveLength(30);
  } finally {
    capture.close();
  }
});

test("quoted lines lose escapes and control characters and are redacted", () => {
  const previous = process.env.SAMPLE_API_TOKEN;
  process.env.SAMPLE_API_TOKEN = "inherited-secret";
  try {
    const lines = sanitizeComposeClientLines({
      text: "\x1b[1;31mfailed\x1b[0m\r\n\tpulling https://user:pw@registry.invalid/x\r progress 10%\rvalue added-secret inherited-secret\n\n\x07bell\n",
      redactValues: ["added-secret", "abc"],
    });
    expect(lines).toEqual([
      "failed",
      "pulling https://[REDACTED]@registry.invalid/x",
      "progress 10%",
      "value [REDACTED] [REDACTED]",
      "bell",
    ]);
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "SAMPLE_API_TOKEN");
    } else {
      process.env.SAMPLE_API_TOKEN = previous;
    }
  }
  const long = sanitizeComposeClientLines({ text: "y".repeat(1000) });
  expect(long[0]).toHaveLength(240);
  expect(long[0]?.endsWith("…")).toBe(true);
});

test("warnings come once each, without their log prefix, up to the limit", () => {
  const text = [
    'WARN[0000] The "A" variable is not set. Defaulting to a blank string.',
    " Container shop-api-1  Created",
    'time="2026-01-01T00:00:00Z" level=warning msg="The \\"A\\" variable is not set. Defaulting to a blank string."',
    "warning: something else",
    "WARN[0001] third",
    "WARN[0001] fourth",
  ].join("\n");
  expect(composeClientWarnings({ text, limit: 5 })).toEqual([
    'The "A" variable is not set. Defaulting to a blank string.',
    "something else",
    "third",
    "fourth",
  ]);
  expect(composeClientWarnings({ text, limit: 2 })).toHaveLength(2);
});

test("the tail and warnings render as plain lines", () => {
  let tail = "";
  writeComposeClientTail(["a", "b"], (text) => {
    tail += text;
  });
  expect(tail).toBe("docker compose output (last 2 lines):\n  a\n  b\n");
  let none = "";
  writeComposeClientTail([], (text) => {
    none += text;
  });
  expect(none).toBe("");
  let warnings = "";
  writeComposeClientWarnings(["unset variable"], (text) => {
    warnings += text;
  });
  expect(warnings).toBe("! compose  unset variable\n");
});

function failureReport(opts: {
  readonly text: string;
  readonly phase: "images" | "start";
}): string[] {
  const capture = openComposeClientCapture(dir);
  try {
    writeSync(capture.fd, opts.text);
    let out = "";
    writeComposeClientFailure({
      capture,
      phase: opts.phase,
      write: (text) => {
        out += text;
      },
    });
    return out.split("\n").filter((line) => line.length > 0);
  } finally {
    capture.close();
  }
}

const numbered = (count: number) =>
  Array.from({ length: count }, (_, i) => `step ${i + 1}`).join("\n");

test("a failed start ends its quoted tail with where to see the full output", () => {
  const out = failureReport({ text: numbered(50), phase: "start" });
  expect(out[0]).toBe("docker compose output (last 20 lines):");
  expect(out[1]).toBe("  step 31");
  expect(out[20]).toBe("  step 50");
  expect(out[21]).toBe(COMPOSE_CLIENT_FULL_OUTPUT_HINT);
  expect(out).toHaveLength(22);
});

test("an images-phase failure quotes more lines, so a build step's output survives its context block", () => {
  const out = failureReport({ text: numbered(50), phase: "images" });
  expect(out[0]).toBe("docker compose output (last 40 lines):");
  expect(out[1]).toBe("  step 11");
  expect(out.at(-1)).toBe(COMPOSE_CLIENT_FULL_OUTPUT_HINT);
});

test("a Compose question in the tail names the foreground start as the way to answer it", () => {
  const out = failureReport({
    text: 'Volume "shop_db" exists but doesn\'t match configuration in compose file. Recreate (data will be lost)? [y/N]\nEOF\n',
    phase: "start",
  });
  expect(out.at(-1)).toBe(COMPOSE_CLIENT_PROMPT_HINT);
  expect(out).not.toContain(COMPOSE_CLIENT_FULL_OUTPUT_HINT);
});

test("a failed start with no client output prints no tail and no hint", () => {
  expect(failureReport({ text: "", phase: "start" })).toEqual([]);
});

test("values the env layers mark non-secret stay quotable; secret, secret-named and unknown ones do not", () => {
  const plain = composeEnvPlainValues({
    scopes: [
      {
        env: {
          PORT: "3000",
          POSTGRES_USER: "postgres",
          DB_PASSWORD: "layer-secret",
          API_KEY: "named-secret",
          NO_METADATA: "unknown-value",
          SHARED_PLAIN: "shared-value",
        },
        metadata: {
          PORT: { secret: false },
          POSTGRES_USER: { secret: false },
          DB_PASSWORD: { secret: true },
          API_KEY: { secret: false },
          SHARED_PLAIN: { secret: false },
        },
      },
      // The same value under a secret entry elsewhere keeps it redacted.
      {
        env: { WORKER_TOKEN_SEED: "shared-value" },
        metadata: { WORKER_TOKEN_SEED: { secret: true } },
      },
    ],
  });
  expect(plain.sort()).toEqual(["3000", "postgres"]);
  expect(
    composeQuoteRedactValues({
      redactValues: [
        "3000",
        "postgres",
        "layer-secret",
        "named-secret",
        "unknown-value",
        "shared-value",
        "remote-added",
      ],
      plainValues: plain,
    })
  ).toEqual([
    "layer-secret",
    "named-secret",
    "unknown-value",
    "shared-value",
    "remote-added",
  ]);
  // No metadata (the legacy env path): everything stays redacted.
  expect(
    composeQuoteRedactValues({
      redactValues: ["3000"],
      plainValues: undefined,
    })
  ).toEqual(["3000"]);
});
