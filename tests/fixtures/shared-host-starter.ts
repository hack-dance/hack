/**
 * Independent starter client for tests/shared-host-lifecycle.test.ts.
 *
 * argv: <spec-json> <holder> [options-json]
 * options: { pauseAt?: event, resume?: "never" | "stdin", linger?: boolean }
 *
 * Prints `event <name>` for each lifecycle event and `result <json>` at the
 * end. With `pauseAt` it stops after printing that event: forever by default
 * (so the test can kill this parent at a precise point, possibly while it
 * holds the helper lock), or until a line arrives on stdin with
 * `resume: "stdin"`. With `linger` it stays alive after printing the result.
 */
import {
  ensureSharedHostHelper,
  type SharedHostEvent,
  type SharedHostHelperSpec,
} from "../../src/lib/shared-host-lifecycle.ts";

type StarterOptions = {
  readonly pauseAt?: SharedHostEvent;
  readonly resume?: "never" | "stdin";
  readonly linger?: boolean;
};

const [specText, holder, optionsText] = process.argv.slice(2);
const spec = JSON.parse(specText ?? "{}") as SharedHostHelperSpec;
const options = JSON.parse(optionsText ?? "{}") as StarterOptions;

async function waitForStdinLine(): Promise<void> {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || decoder.decode(value, { stream: true }).includes("\n")) {
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const result = await ensureSharedHostHelper({
  spec,
  holder: holder ?? "",
  observe: async (event) => {
    console.log(`event ${event}`);
    if (event !== options.pauseAt) {
      return;
    }
    if (options.resume === "stdin") {
      await waitForStdinLine();
      return;
    }
    // An interval keeps the event loop alive until the test kills us.
    await new Promise(() => setInterval(() => undefined, 60_000));
  },
});
console.log(`result ${JSON.stringify(result)}`);
if (options.linger) {
  setInterval(() => undefined, 60_000);
}
