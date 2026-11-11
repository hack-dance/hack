import { expect, test } from "bun:test";
import { resolvePersistentLifecycleNames } from "../src/lib/project-lifecycle-controller.ts";

test("persistent lifecycle names list persistent up.before hooks by name or position, then processes", () => {
  expect(
    resolvePersistentLifecycleNames({
      up: {
        before: [
          { command: "synthetic-prepare" },
          { command: "synthetic-tunnels", persistent: true },
          { command: "synthetic-broker", name: "broker", persistent: true },
        ],
      },
      processes: [{ name: "watcher" }],
    })
  ).toEqual(["hook-2", "broker", "watcher"]);
  expect(resolvePersistentLifecycleNames(undefined)).toEqual([]);
});
