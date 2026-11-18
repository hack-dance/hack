import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyDownObservation,
  downIncompleteMessage,
  type InstanceContainer,
  listInstanceContainersByProject,
  parseInstanceContainers,
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

async function checkout() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hack-stop-")));
  roots.push(root);
  const projectDir = join(root, "repo", ".hack");
  await mkdir(projectDir, { recursive: true });
  return { root, projectDir };
}

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

test("only containers whose Compose working dir is this checkout are stopped", async () => {
  const { root, projectDir } = await checkout();
  const linked = join(root, "linked-hack");
  await symlink(projectDir, linked);
  const owned = selectOwnedInstanceContainers({
    projectDir,
    containers: [
      container({ id: "a", workingDir: projectDir }),
      // The same directory spelled through a symlink is the same checkout.
      container({ id: "b", workingDir: linked }),
      // Another checkout sharing the Compose project name is never stopped.
      container({ id: "c", workingDir: join(root, "other", ".hack") }),
      // Without a working dir label, ownership is unknown: never stopped.
      container({ id: "d", workingDir: null }),
    ],
  });
  expect(owned.map((entry) => entry.id)).toEqual(["a", "b"]);
});

test("observed result: complete only when nothing of the project may still run", async () => {
  const { root, projectDir } = await checkout();
  const observe = (containers: InstanceContainer[]) =>
    classifyDownObservation({
      listing: { ok: true, containers },
      projectDir,
    });
  expect(observe([])).toEqual({ complete: true });
  // created, exited and dead do not run; they do not make the down incomplete.
  expect(
    observe([
      container({ id: "x", state: "exited", workingDir: projectDir }),
      container({ id: "y", state: "created", workingDir: projectDir }),
      container({ id: "z", state: "dead", workingDir: null }),
    ])
  ).toEqual({ complete: true });
  const other = join(root, "worktree", ".hack");
  expect(
    observe([
      container({ id: "1", service: "worker", workingDir: projectDir }),
      container({ id: "2", service: "extra", state: "restarting" }),
      // Unknown ownership that may run is not hidden.
      container({ id: "3", service: "db", state: "paused", workingDir: null }),
      // An unrecognised state may run.
      container({
        id: "4",
        service: "web",
        state: "removing",
        workingDir: projectDir,
      }),
      // Another checkout: never stopped here, but reported.
      container({ id: "5", service: "worker", workingDir: other }),
    ])
  ).toEqual({
    complete: false,
    running: ["db", "web", "worker"],
    foreign: [
      { service: "extra", workingDir: "/nowhere/.hack" },
      { service: "worker", workingDir: other },
    ],
  });
});

test("an unknown listing is incomplete, never 'none left'", async () => {
  const { projectDir } = await checkout();
  const observation = classifyDownObservation({
    listing: { ok: false, reason: "docker ps timed out after 15000ms" },
    projectDir,
  });
  expect(observation).toEqual({
    complete: false,
    running: [],
    foreign: [],
    unknownReason: "docker ps timed out after 15000ms",
  });
  if (!observation.complete) {
    expect(downIncompleteMessage({ observation })).toBe(
      "Could not confirm that this instance stopped: docker ps timed out after 15000ms. Run `hack ps --json` to inspect, then `hack down` again."
    );
  }
});

test("listing: docker ps failure, timeout and malformed output are unknown", async () => {
  const fail = await listInstanceContainersByProject({
    composeProject: "demo",
    timeoutMs: 1000,
    run: () => Promise.resolve({ exitCode: 1, stdout: "", stderr: "boom" }),
  });
  expect(fail).toEqual({ ok: false, reason: "docker ps failed (exit 1)" });
  const timeout = await listInstanceContainersByProject({
    composeProject: "demo",
    timeoutMs: 1000,
    run: () => Promise.resolve({ exitCode: 124, stdout: "", stderr: "" }),
  });
  expect(timeout).toEqual({
    ok: false,
    reason: "docker ps timed out after 1000ms",
  });
  const thrown = await listInstanceContainersByProject({
    composeProject: "demo",
    timeoutMs: 1000,
    run: () => Promise.reject(new Error("spawn failed")),
  });
  expect(thrown).toEqual({ ok: false, reason: "spawn failed" });
  expect(parseInstanceContainers("not json\n")).toEqual({
    ok: false,
    reason: "docker ps printed an unreadable line",
  });
  expect(
    parseInstanceContainers(
      '{"id":"abc","state":"Running","service":"worker","workingDir":"/p/.hack"}\n{"id":"def","state":"exited","service":"","workingDir":""}\n'
    )
  ).toEqual({
    ok: true,
    containers: [
      {
        id: "abc",
        state: "running",
        service: "worker",
        workingDir: "/p/.hack",
      },
      { id: "def", state: "exited", service: "", workingDir: null },
    ],
  });
});

test("the incomplete-down message names services and, for another checkout, its directory", () => {
  expect(
    downIncompleteMessage({
      observation: {
        complete: false,
        running: ["extra"],
        foreign: [{ service: "worker", workingDir: "/w/.hack" }],
      },
    })
  ).toBe(
    "docker compose down left a container of this instance still running (extra); run `hack ps --json` to inspect, then `hack down` again; and running containers of the same Compose project started from another checkout (worker); run `hack down` from /w/.hack."
  );
});
