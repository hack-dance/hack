import { expect, test } from "bun:test";
import {
  COMPOSE_CLIENT_DECLINED_HINT,
  COMPOSE_CLIENT_FULL_OUTPUT_HINT,
  COMPOSE_CLIENT_LINE_CHARS,
  COMPOSE_CLIENT_PROMPT_HINT,
  COMPOSE_CLIENT_TAIL_CHARS,
  COMPOSE_CLIENT_WARNING_CHARS,
  type ComposeClientCapture,
  composeClientWarnings,
  composeQuestionText,
  isComposeQuestionLine,
  openComposeClientCapture,
  sanitizeComposeClientLines,
  writeComposeClientFailure,
  writeComposeClientQuestions,
  writeComposeClientTail,
  writeComposeClientWarnings,
} from "../src/lib/compose-client-output.ts";
import {
  composeEnvPlainValues,
  composeQuoteRedactValues,
} from "../src/lib/compose-ps-result.ts";

const encoder = new TextEncoder();
const feed = (
  capture: ComposeClientCapture,
  text: string,
  stream: "stdout" | "stderr" = "stderr"
) => capture.write(encoder.encode(text), stream);

/** The most the capture may hold, however much the client prints. */
const RETAINED_BOUND =
  COMPOSE_CLIENT_TAIL_CHARS +
  COMPOSE_CLIENT_WARNING_CHARS +
  2 * COMPOSE_CLIENT_LINE_CHARS;

test("the capture holds lines in memory, and nothing after close", () => {
  const capture = openComposeClientCapture();
  feed(capture, "one\ntwo\n");
  expect(capture.tail()).toEqual(["one", "two"]);
  capture.close();
  // A second close, a write and a read after close are harmless.
  capture.close();
  feed(capture, "three\n");
  expect(capture.tail()).toEqual([]);
  expect(capture.warnings()).toEqual([]);
  expect(capture.retainedChars()).toBe(0);
});

test("the tail keeps only the last lines and cuts an overlong line", () => {
  const capture = openComposeClientCapture();
  try {
    feed(capture, `${"x".repeat(70_000)}\n`);
    for (let index = 1; index <= 30; index += 1) {
      feed(capture, `line ${index}\n`);
    }
    expect(capture.tail({ lines: 5 })).toEqual([
      "line 26",
      "line 27",
      "line 28",
      "line 29",
      "line 30",
    ]);
    const all = capture.tail({ lines: 10_000 });
    expect(all).toHaveLength(31);
    // The overlong line is kept only up to its bound, then quoted shorter.
    expect(all[0]?.startsWith("xxx")).toBe(true);
    expect(all[1]).toBe("line 1");
  } finally {
    capture.close();
  }
});

test("a verbose client cannot grow the capture past its bound", () => {
  const capture = openComposeClientCapture();
  try {
    // About 20 MiB over both streams, far past every cap.
    const block =
      `${"#12 [build 3/9] RUN make all ".padEnd(199, ".")}\n`.repeat(1024);
    for (let round = 0; round < 50; round += 1) {
      feed(capture, block, round % 2 === 0 ? "stdout" : "stderr");
      expect(capture.retainedChars()).toBeLessThanOrEqual(RETAINED_BOUND);
    }
    // One endless line without a break is bounded too.
    for (let round = 0; round < 100; round += 1) {
      feed(capture, "y".repeat(64 * 1024), "stdout");
    }
    expect(capture.retainedChars()).toBeLessThanOrEqual(RETAINED_BOUND);
    feed(capture, "\nfailed to solve: process did not complete\n", "stdout");
    expect(capture.tail({ lines: 1 })).toEqual([
      "failed to solve: process did not complete",
    ]);
    expect(capture.retainedChars()).toBeLessThanOrEqual(RETAINED_BOUND);
  } finally {
    capture.close();
  }
});

test("a warning printed after more than 64 KiB of output still shows, as do earlier ones", () => {
  const capture = openComposeClientCapture();
  try {
    feed(capture, "WARN[0000] early warning\n");
    for (let index = 0; index < 2000; index += 1) {
      feed(capture, `#7 ${index} building layer ${"z".repeat(60)}\n`, "stdout");
    }
    feed(
      capture,
      'time="2026-01-01T00:00:01Z" level=warning msg="late warning after the build"\n'
    );
    for (let index = 0; index < 2000; index += 1) {
      feed(capture, ` Container shop-api-${index}  Started\n`, "stdout");
    }
    expect(capture.warnings()).toEqual([
      "early warning",
      "late warning after the build",
    ]);
  } finally {
    capture.close();
  }
});

test("a warning repeated under different timestamps takes one slot, so a later distinct warning is kept", () => {
  const capture = openComposeClientCapture();
  try {
    for (let second = 0; second < 70; second += 1) {
      feed(
        capture,
        `time="2026-01-01T00:00:${String(second).padStart(2, "0")}Z" level=warning msg="The \\"A\\" variable is not set."\n`
      );
    }
    feed(capture, 'time="2026-01-01T00:01:10Z" level=warning msg="late one"\n');
    expect(capture.warnings({ limit: 10 })).toEqual([
      'The "A" variable is not set.',
      "late one",
    ]);
  } finally {
    capture.close();
  }
});

test("questions are told apart from warnings, build steps and ordinary lines", () => {
  for (const line of [
    'Volume "shop_db" exists but doesn\'t match configuration in compose file. Recreate (data will be lost)?',
    "Recreate (data will be lost)? [y/N]",
    "Continue? [Y/n]",
    "Proceed (y/N)",
    "Are you sure you want to remove? [yN]",
    "? Volume exists. Recreate",
  ]) {
    expect(isComposeQuestionLine(line), line).toBe(true);
  }
  for (const line of [
    " Container shop-api-1  Started",
    "#12 [build 3/9] RUN echo 'ready?'",
    'time="2026-01-01T00:00:00Z" level=warning msg="why?"',
    "WARN[0000] unset?",
    "Error response from daemon: conflict",
  ]) {
    expect(isComposeQuestionLine(line), line).toBe(false);
  }
});

test("a question that Compose's next progress text joined on the same line is still found, without that text", () => {
  // Docker Compose v5.7.1 with stdin closed and no terminal, against a volume
  // whose labels changed: it prints the question with no line break, reads
  // end-of-input, keeps the volume, goes on, and exits 0.
  const joined =
    'Volume "cq_data" exists but doesn\'t match configuration in compose file. Recreate (data will be lost)? Container cq-app-1 Running ';
  const question =
    'Volume "cq_data" exists but doesn\'t match configuration in compose file. Recreate (data will be lost)?';
  expect(isComposeQuestionLine(joined)).toBe(true);
  expect(composeQuestionText(joined)).toBe(question);
  for (const line of [
    "Pulling https://registry.example/v2/app/manifests/1?digest=sha256",
    " Container cq-app-1  Running",
  ]) {
    expect(isComposeQuestionLine(line), line).toBe(false);
  }
  const capture = openComposeClientCapture();
  try {
    feed(capture, joined, "stderr");
    capture.end?.("stderr");
    feed(capture, joined, "stderr");
    capture.end?.("stderr");
    expect(capture.questions()).toEqual([question]);
  } finally {
    capture.close();
  }
});

test("a question longer than the display limit is still reported", () => {
  const volume = `v${"x".repeat(150)}`;
  const long = `Volume "${volume}" exists but doesn't match configuration in compose file. Recreate (data will be lost)? Container app-1 Running `;
  expect(long.length).toBeGreaterThan(240);
  const capture = openComposeClientCapture();
  try {
    feed(capture, long, "stderr");
    capture.end?.("stderr");
    const questions = capture.questions();
    expect(questions).toHaveLength(1);
    expect(questions[0]?.startsWith(`Volume "${volume.slice(0, 40)}`)).toBe(
      true
    );
  } finally {
    capture.close();
  }
});

test("a question without a line break is complete when its stream ends, and never joins the next phase", () => {
  const capture = openComposeClientCapture();
  try {
    // The images phase asks on stdout and ends; the start phase prints next.
    feed(capture, "Recreate (data will be lost)?", "stdout");
    capture.end?.("stdout");
    capture.end?.("stderr");
    feed(capture, "compose-up-stdout-marker\n", "stdout");
    expect(capture.tail()).toEqual([
      "Recreate (data will be lost)?",
      "compose-up-stdout-marker",
    ]);
    expect(capture.questions()).toEqual(["Recreate (data will be lost)?"]);
    // A long build after it does not lose it, and it is kept once.
    for (let index = 0; index < 2000; index += 1) {
      feed(capture, `#7 ${index} layer ${"z".repeat(60)}\n`, "stdout");
    }
    feed(capture, "Recreate (data will be lost)?\n", "stdout");
    expect(capture.questions()).toEqual(["Recreate (data will be lost)?"]);
    expect(capture.warnings()).toEqual([]);
  } finally {
    capture.close();
  }
});

test("unanswered questions from a successful start render with how to answer them", () => {
  let out = "";
  writeComposeClientQuestions(["Recreate (data will be lost)?"], (text) => {
    out += text;
  });
  expect(out).toBe(
    `! compose  unanswered question: Recreate (data will be lost)?\n${COMPOSE_CLIENT_DECLINED_HINT}\n`
  );
  let none = "";
  writeComposeClientQuestions([], (text) => {
    none += text;
  });
  expect(none).toBe("");
});

test("each stream is split into lines on its own, across chunk and character boundaries", () => {
  const capture = openComposeClientCapture();
  try {
    feed(capture, "out-", "stdout");
    feed(capture, "err-", "stderr");
    feed(capture, "one\r", "stdout");
    feed(capture, "one\n", "stderr");
    feed(capture, "\nout-two\n", "stdout");
    // A multi-byte character split across two chunks.
    const bytes = encoder.encode("café\n");
    capture.write(bytes.subarray(0, 4), "stderr");
    capture.write(bytes.subarray(4), "stderr");
    // A question Compose asks has no line break after it.
    feed(capture, "Recreate (data will be lost)? [y/N] ", "stderr");
    expect(capture.tail({ lines: 10 })).toEqual([
      "out-one",
      "err-one",
      "out-two",
      "café",
      "Recreate (data will be lost)? [y/N]",
    ]);
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
  const capture = openComposeClientCapture();
  try {
    feed(capture, opts.text);
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

test("a failed start names a question its quoted lines no longer show", () => {
  const out = failureReport({
    text: `Recreate (data will be lost)?\n${numbered(30)}\n`,
    phase: "start",
  });
  expect(out[0]).toBe("docker compose output (last 20 lines):");
  expect(out).not.toContain("  Recreate (data will be lost)?");
  expect(out.slice(-2)).toEqual([
    "Compose asked earlier: Recreate (data will be lost)?",
    COMPOSE_CLIENT_PROMPT_HINT,
  ]);
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
