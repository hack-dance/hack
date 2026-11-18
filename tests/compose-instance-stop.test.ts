import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyDownObservation,
  downIncompleteMessage,
  type InstanceContainer,
  parseComposeLabels,
  parseComposePsInstanceContainers,
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

test("compose ps listing: lines or array, labels with commas, malformed output unknown", () => {
  const line = (fields: Record<string, unknown>) => JSON.stringify(fields);
  expect(parseComposePsInstanceContainers("")).toEqual({
    ok: true,
    containers: [],
  });
  expect(
    parseComposePsInstanceContainers(
      [
        line({
          ID: "abc",
          State: "Running",
          Service: "worker",
          Labels:
            "com.docker.compose.project=demo,com.docker.compose.project.working_dir=/p/a,b/.hack,com.docker.compose.service=worker",
        }),
        line({ ID: "def", State: "exited", Service: "web", Labels: "" }),
      ].join("\n")
    )
  ).toEqual({
    ok: true,
    containers: [
      {
        id: "abc",
        state: "running",
        service: "worker",
        workingDir: "/p/a,b/.hack",
      },
      { id: "def", state: "exited", service: "web", workingDir: null },
    ],
  });
  // Older Compose prints one JSON array.
  expect(
    parseComposePsInstanceContainers(
      JSON.stringify([{ ID: "x", State: "running", Service: "web" }])
    )
  ).toEqual({
    ok: true,
    containers: [
      { id: "x", state: "running", service: "web", workingDir: null },
    ],
  });
  expect(parseComposePsInstanceContainers("not json")).toEqual({
    ok: false,
    reason: "docker compose ps printed an unreadable line",
  });
  expect(parseComposePsInstanceContainers('{"Name":"x"}')).toEqual({
    ok: false,
    reason: "docker compose ps printed an unexpected entry",
  });
  expect(parseComposeLabels("a=1,b=x,y,c=")).toEqual({
    a: "1",
    b: "x,y",
    c: "",
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
