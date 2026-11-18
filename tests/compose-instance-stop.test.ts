import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyDownObservation,
  downIncompleteMessage,
  type InstanceContainer,
  resolveInstanceStopProfiles,
  selectOwnedInstanceContainers,
} from "../src/lib/compose-instance-stop.ts";

/** HACK-2340: a down stops every profile the instance started and reports what it observed. */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function container(
  overrides: Partial<InstanceContainer> & { readonly id: string }
): InstanceContainer {
  return {
    service: "web",
    state: "running",
    workingDir: "/nowhere/.hack",
    ...overrides,
  };
}

test("stop profiles: recorded, CLI and current env, in that order, without duplicates", () => {
  expect(
    resolveInstanceStopProfiles({
      recorded: ["workers", "extra"],
      cliProfiles: ["debug", "extra"],
      currentProfiles: [" tools ", "workers", ""],
    })
  ).toEqual(["workers", "extra", "debug", "tools"]);
  // No record (state from an older Hack): the current env still counts.
  expect(
    resolveInstanceStopProfiles({
      recorded: undefined,
      cliProfiles: [],
      currentProfiles: ["extra"],
    })
  ).toEqual(["extra"]);
  // An env changed since up cannot drop a recorded profile.
  expect(
    resolveInstanceStopProfiles({
      recorded: ["extra"],
      cliProfiles: [],
      currentProfiles: [],
    })
  ).toEqual(["extra"]);
});

test("only containers whose Compose working dir is this checkout are owned", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hack-stop-")));
  roots.push(root);
  const projectDir = join(root, "repo", ".hack");
  await mkdir(projectDir, { recursive: true });
  const linked = join(root, "linked-hack");
  await symlink(projectDir, linked);
  const owned = selectOwnedInstanceContainers({
    projectDir,
    containers: [
      container({ id: "a", workingDir: projectDir }),
      // The same directory spelled through a symlink is the same checkout.
      container({ id: "b", workingDir: linked }),
      // Another checkout sharing the Compose project name is never touched.
      container({ id: "c", workingDir: join(root, "other", ".hack") }),
      container({ id: "d", workingDir: null }),
    ],
  });
  expect(owned.map((entry) => entry.id)).toEqual(["a", "b"]);
});

test("observed result: complete only when nothing of the instance still runs", () => {
  expect(classifyDownObservation({ remaining: [] })).toEqual({
    complete: true,
  });
  // A stopped leftover is not running; the stop removes it, but it does not
  // make the down incomplete.
  expect(
    classifyDownObservation({
      remaining: [container({ id: "x", state: "exited" })],
    })
  ).toEqual({ complete: true });
  expect(
    classifyDownObservation({
      remaining: [
        container({ id: "1", service: "worker", state: "running" }),
        container({ id: "2", service: "extra", state: "restarting" }),
        container({ id: "3", service: "worker", state: "paused" }),
        container({ id: "4", service: "web", state: "exited" }),
      ],
    })
  ).toEqual({
    complete: false,
    running: ["extra", "worker"],
    containerIds: ["1", "2", "3"],
  });
});

test("the incomplete-down message names the services and the next step, no values", () => {
  expect(downIncompleteMessage({ running: ["extra"] })).toBe(
    "docker compose down left a container of this instance running (extra). Run `hack ps --json` to inspect, then `hack down` again."
  );
  expect(downIncompleteMessage({ running: ["a", "b"] })).toContain(
    "left containers of this instance running (a, b)"
  );
});
