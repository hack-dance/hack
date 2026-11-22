import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildComposeDownRetryFailure,
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

test("one-off run containers are never stopped and never make a down incomplete", async () => {
  const { projectDir } = await checkout();
  const listing = parseComposePsInstanceContainers(
    JSON.stringify({
      ID: "run1",
      State: "running",
      Service: "web",
      Labels: `com.docker.compose.oneoff=True,com.docker.compose.project.working_dir=${projectDir}`,
    })
  );
  expect(listing).toEqual({
    ok: true,
    containers: [
      {
        oneOff: true,
        id: "run1",
        state: "running",
        service: "web",
        workingDir: projectDir,
      },
    ],
  });
  if (!listing.ok) {
    return;
  }
  // A background `hack run` keeps running through `hack down`.
  expect(
    selectOwnedInstanceContainers({
      containers: listing.containers,
      projectDir,
    })
  ).toEqual([]);
  expect(classifyDownObservation({ listing, projectDir })).toEqual({
    complete: true,
  });
});

test("retry failure formats cap timeout with remaining project network and next steps", async () => {
  const { projectDir } = await checkout();
  const failure = buildComposeDownRetryFailure({
    exitCode: 124,
    timedOut: true,
    capMs: 90_000,
    listing: { ok: true, containers: [] },
    networks: { ok: true, networks: ["demo_default", "demo_default", " "] },
    projectDir,
  });
  expect(failure).toEqual({
    exitCode: 124,
    message:
      "docker compose down retry reached its 90s cap before finishing; network still present (demo_default). Run `hack ps --json` to inspect and `hack down` again (pass `--timeout <seconds>` or set `compose.downTimeoutSeconds` if cleanup needs more time).",
    detail: {
      exitCode: 124,
      retry: true,
      timedOut: true,
      capMs: 90_000,
      containers: [],
      networks: ["demo_default"],
    },
  });
});

test("retry failure includes stopped containers, foreign checkouts, networks, and ignores one-off containers", async () => {
  const { root, projectDir } = await checkout();
  const other = join(root, "other", ".hack");
  const failure = buildComposeDownRetryFailure({
    exitCode: 1,
    timedOut: false,
    capMs: 90_000,
    listing: {
      ok: true,
      containers: [
        container({
          id: "c1",
          service: "worker",
          state: "exited",
          workingDir: projectDir,
        }),
        container({
          id: "c2",
          service: "api",
          state: "running",
          workingDir: projectDir,
        }),
        container({
          id: "c3",
          service: "web",
          state: "running",
          workingDir: other,
        }),
        container({
          id: "c4",
          service: "oneshot",
          state: "running",
          workingDir: projectDir,
          oneOff: true,
        }),
      ],
    },
    networks: { ok: true, networks: ["demo_internal", "demo_default"] },
    projectDir,
  });
  expect(failure.exitCode).toBe(1);
  expect(failure.detail).toEqual({
    exitCode: 1,
    retry: true,
    containers: ["api", "worker"],
    foreign: [{ service: "web", workingDir: other }],
    networks: ["demo_default", "demo_internal"],
  });
  expect(failure.message).toBe(
    `docker compose down retry failed (exit 1); containers still present (api, worker), container from another checkout (web), networks still present (demo_default, demo_internal). Run \`hack down\` from ${other}, then \`hack ps --json\` to inspect and \`hack down\` again.`
  );
});

test("retry failure reports unknown checks and clean remainders without faking cap timeout", async () => {
  const { projectDir } = await checkout();
  const unknown = buildComposeDownRetryFailure({
    exitCode: 124,
    timedOut: false,
    capMs: 90_000,
    listing: { ok: false, reason: "docker compose ps timed out" },
    networks: { ok: false, reason: "docker network ls failed (exit 1)" },
    projectDir,
  });
  expect(unknown.detail).toEqual({
    exitCode: 124,
    retry: true,
    containers: [],
    networks: [],
    containersUnknownReason: "docker compose ps timed out",
    networksUnknownReason: "docker network ls failed (exit 1)",
  });
  expect(unknown.message).toContain(
    "docker compose down retry failed (exit 124)"
  );
  expect(unknown.message).not.toContain("reached its");
  expect(unknown.message).toContain(
    "containers could not be checked (docker compose ps timed out)"
  );
  expect(unknown.message).toContain(
    "networks could not be checked (docker network ls failed (exit 1))"
  );

  const clean = buildComposeDownRetryFailure({
    exitCode: 1,
    timedOut: false,
    capMs: 90_000,
    listing: { ok: true, containers: [] },
    networks: { ok: true, networks: [] },
    projectDir,
  });
  expect(clean.message).toBe(
    "docker compose down retry failed (exit 1); no containers or project networks remain. Run `hack ps --json` to inspect and `hack down` again."
  );
});

test("retry success observation is incomplete while a project network remains or cannot be checked", async () => {
  const { projectDir } = await checkout();
  expect(
    classifyDownObservation({
      listing: { ok: true, containers: [] },
      networks: { ok: true, networks: [] },
      projectDir,
    })
  ).toEqual({ complete: true });

  const withNetwork = classifyDownObservation({
    listing: { ok: true, containers: [] },
    networks: { ok: true, networks: ["demo_default", "demo_default"] },
    projectDir,
  });
  expect(withNetwork).toEqual({
    complete: false,
    running: [],
    foreign: [],
    networks: ["demo_default"],
  });
  if (!withNetwork.complete) {
    expect(downIncompleteMessage({ observation: withNetwork })).toBe(
      "docker compose down left a project network still present (demo_default); run `hack ps --json` to inspect, then `hack down` again."
    );
  }

  const unknownNet = classifyDownObservation({
    listing: { ok: true, containers: [] },
    networks: { ok: false, reason: "docker network ls timed out" },
    projectDir,
  });
  expect(unknownNet).toEqual({
    complete: false,
    running: [],
    foreign: [],
    networksUnknownReason: "docker network ls timed out",
  });
  if (!unknownNet.complete) {
    expect(downIncompleteMessage({ observation: unknownNet })).toBe(
      "Could not confirm that this instance stopped: docker network ls timed out. Run `hack ps --json` to inspect, then `hack down` again."
    );
  }
});
