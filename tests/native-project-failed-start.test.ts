import { expect, test } from "bun:test";
import { discardUnpublishedNativeStart } from "../src/backends/native-project-failed-start.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";

const run = "1".repeat(32);
const owner = "c".repeat(32);
function graph(phase: string, extra: Record<string, unknown> = {}) {
  return {
    journal_incomplete: false,
    receipt: { run, owner, phase, ...extra },
    observations: {},
  };
}
function options(
  overrides: Partial<Parameters<typeof discardUnpublishedNativeStart>[0]> = {}
) {
  const requests: string[] = [];
  const notices: string[] = [];
  let removed = false;
  const opts: Parameters<typeof discardUnpublishedNativeStart>[0] = {
    runtime: { binary: "/synthetic/native", home: "/synthetic/home" },
    projectRoot: "/synthetic/project",
    run,
    owner,
    final: graph("stopped-data-retained"),
    restored: false,
    mappingAttempted: false,
    warn: (line) => notices.push(line),
    invoke: async (request) => {
      requests.push(request.args.join(" "));
      if (request.args[1] === "cleanup") {
        removed = true;
        return {};
      }
      return graph(removed ? "removed" : "stopped-data-retained");
    },
    ...overrides,
  };
  return { opts, requests, notices };
}

test("an unpublished fresh graph is removed and confirmed by fresh inspection", async () => {
  const { opts, requests, notices } = options();
  expect(await discardUnpublishedNativeStart(opts)).toBe("removed");
  expect(requests).toEqual([
    `graph cleanup --run-id ${run} --remove-data --json`,
    `graph inspect --run-id ${run} --json`,
  ]);
  expect(notices).toEqual([]);
});

test("retained, restored, attempted or other graphs are never removed", async () => {
  for (const overrides of [
    { restored: true },
    { mappingAttempted: true },
    { final: graph("removed") },
    { final: graph("cleanup-intent") },
    { final: graph("stopped-data-retained", { owner: "d".repeat(32) }) },
    { final: graph("stopped-data-retained", { run: "2".repeat(32) }) },
    { final: { ...graph("stopped-data-retained"), journal_incomplete: true } },
    { final: null },
  ]) {
    const { opts, requests, notices } = options(overrides);
    expect(await discardUnpublishedNativeStart(opts)).toBe("not_applicable");
    expect(requests).toEqual([]);
    expect(notices).toEqual([]);
  }
});

test("unconfirmed removal retains the graph and names the run and explicit removal", async () => {
  const failing = options({
    invoke: async () => {
      throw new NativeRuntimeRequestError({
        message: "synthetic-do-not-print",
        nativeCode: "graph_relay_enrollment",
      });
    },
  });
  expect(await discardUnpublishedNativeStart(failing.opts)).toBe("retained");
  expect(failing.notices).toHaveLength(1);
  expect(failing.notices[0]).toContain(run);
  expect(failing.notices[0]).toContain("(graph_relay_enrollment)");
  expect(failing.notices[0]).toContain(
    `graph cleanup --run-id ${run} --remove-data --json`
  );
  expect(failing.notices[0]).not.toContain("synthetic-do-not-print");

  // A cleanup reply without a removed receipt is not removal.
  const unconfirmed = options({
    invoke: async () => graph("stopped-data-retained"),
  });
  expect(await discardUnpublishedNativeStart(unconfirmed.opts)).toBe(
    "retained"
  );
  expect(unconfirmed.notices).toHaveLength(1);
  expect(unconfirmed.notices[0]).not.toContain("(");
});
