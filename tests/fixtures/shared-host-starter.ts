/**
 * Independent starter client for tests/shared-host-lifecycle.test.ts.
 *
 * argv: <spec-json> <holder> [pause-event]
 * Prints `event <name>` for each lifecycle event and `result <json>` at the
 * end. With a pause event it stops forever after printing that event, so the
 * test can kill this parent at a precise point.
 */
import {
  ensureSharedHostHelper,
  type SharedHostHelperSpec,
} from "../../src/lib/shared-host-lifecycle.ts";

const [specText, holder, pauseAt] = process.argv.slice(2);
const spec = JSON.parse(specText ?? "{}") as SharedHostHelperSpec;
const result = await ensureSharedHostHelper({
  spec,
  holder: holder ?? "",
  observe: async (event) => {
    console.log(`event ${event}`);
    if (event === pauseAt) {
      // An interval keeps the event loop alive until the test kills us.
      await new Promise(() => setInterval(() => undefined, 60_000));
    }
  },
});
console.log(`result ${JSON.stringify(result)}`);
