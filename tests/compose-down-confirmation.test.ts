import { expect, test } from "bun:test";
import { stopSessionBeforeReleasingHelpers } from "../src/commands/project.ts";
import {
  type ComposeProjectContainer,
  type ComposeProjectContainerListing,
  confirmComposeDownStopped,
  containersThatMayRun,
  describeUnconfirmedComposeDown,
  listComposeProjectContainers,
  parseComposeProjectContainers,
} from "../src/lib/compose-down-confirmation.ts";

/**
 * A successful `docker compose down` (current file, no --remove-orphans) can
 * leave orphan containers running. Shared helper holders are released only
 * once no container labelled with the Compose project may still run (HACK-1864).
 * The Docker listing is a fake runner; the holder bookkeeping is a fake set
 * driven through the real stopSessionBeforeReleasingHelpers.
 */

const PROJECT = "demo--feat-a";

function line(name: string, state: string): string {
  return JSON.stringify({ name, state });
}

/** One instance with a sole shared-helper holder and a fake Compose project. */
function instance(containers: ComposeProjectContainerListing | Error) {
  const state = {
    held: new Set(["issuer-bridge"]),
    listing: containers,
    listCalls: 0,
  };
  const down = async (downCode = 0) => {
    const confirmation = await confirmComposeDownStopped({
      downCode,
      heldHelperNames: () => Promise.resolve([...state.held]),
      listContainers: () => {
        state.listCalls += 1;
        return state.listing instanceof Error
          ? Promise.reject(state.listing)
          : Promise.resolve(state.listing);
      },
    });
    const outcome = await stopSessionBeforeReleasingHelpers({
      stopSession: () => Promise.resolve(),
      containers: confirmation.containers,
      releaseHelpers: () => {
        state.held.clear();
        return Promise.resolve([]);
      },
      heldHelperNames: () => Promise.resolve([...state.held]),
    });
    return { confirmation, notReleased: outcome.notReleased };
  };
  return { state, down };
}

function listing(
  ...containers: ComposeProjectContainer[]
): ComposeProjectContainerListing {
  return { ok: true, containers };
}

test("a surviving orphan keeps the holder and reports the down incomplete", async () => {
  const { state, down } = instance(
    listing(
      { name: "demo--feat-a-api-1", state: "exited" },
      { name: "demo--feat-a-worker-1", state: "running" }
    )
  );
  const result = await down();
  expect(result.confirmation).toEqual({
    containers: "unconfirmed",
    reason: {
      kind: "containers-remain",
      remaining: [{ name: "demo--feat-a-worker-1", state: "running" }],
    },
  });
  // A non-empty list fails hack down with E_LIFECYCLE_FAILED.
  expect(result.notReleased).toEqual(["issuer-bridge"]);
  expect([...state.held]).toEqual(["issuer-bridge"]);
  const message = describeUnconfirmedComposeDown({
    composeProject: PROJECT,
    confirmation: result.confirmation,
  });
  expect(message).toContain("demo--feat-a-worker-1 (running)");
  expect(message).toContain(`docker compose -p ${PROJECT} down`);
});

test("a project with no container left releases the holder", async () => {
  const { state, down } = instance(listing());
  const result = await down();
  expect(result.confirmation).toEqual({ containers: "stopped" });
  expect(result.notReleased).toEqual([]);
  expect(state.held.size).toBe(0);
});

test("a failed, timed-out, unreadable or throwing listing keeps the holder", async () => {
  const failures: (ComposeProjectContainerListing | Error)[] = [
    { ok: false, reason: "docker ps failed (exit 1)" },
    { ok: false, reason: "docker ps timed out after 15000ms" },
    parseComposeProjectContainers("not json\n"),
    new Error("docker unavailable"),
  ];
  for (const failure of failures) {
    const { state, down } = instance(failure);
    const result = await down();
    expect(result.confirmation.containers).toBe("unconfirmed");
    expect(
      result.confirmation.containers === "unconfirmed" &&
        result.confirmation.reason.kind
    ).toBe("probe-failed");
    expect(result.notReleased).toEqual(["issuer-bridge"]);
    expect([...state.held]).toEqual(["issuer-bridge"]);
    expect(
      describeUnconfirmedComposeDown({
        composeProject: PROJECT,
        confirmation: result.confirmation,
      })
    ).toContain("Could not confirm");
  }
});

test("a later down after the orphan exits releases the retained holder", async () => {
  const { state, down } = instance(
    listing({ name: "demo--feat-a-worker-1", state: "running" })
  );
  expect((await down()).notReleased).toEqual(["issuer-bridge"]);
  // The orphan stopped (or was removed with --remove-orphans).
  state.listing = listing({ name: "demo--feat-a-worker-1", state: "exited" });
  const retried = await down();
  expect(retried.confirmation).toEqual({ containers: "stopped" });
  expect(retried.notReleased).toEqual([]);
  expect(state.held.size).toBe(0);
});

test("a failed Compose down stays unconfirmed without listing containers", async () => {
  const { state, down } = instance(listing());
  const result = await down(124);
  expect(result.confirmation).toEqual({
    containers: "unconfirmed",
    reason: { kind: "down-failed", exitCode: 124 },
  });
  expect(state.listCalls).toBe(0);
  expect(result.notReleased).toEqual(["issuer-bridge"]);
});

test("an instance holding no shared helper needs no container listing", async () => {
  let listed = 0;
  const confirmation = await confirmComposeDownStopped({
    downCode: 0,
    heldHelperNames: () => Promise.resolve([]),
    listContainers: () => {
      listed += 1;
      return Promise.resolve(listing());
    },
  });
  expect(confirmation).toEqual({ containers: "stopped" });
  expect(listed).toBe(0);
});

test("an unreadable holder record still lists the containers", async () => {
  const confirmation = await confirmComposeDownStopped({
    downCode: 0,
    heldHelperNames: () => Promise.reject(new Error("unreadable")),
    listContainers: () =>
      Promise.resolve(listing({ name: "orphan", state: "running" })),
  });
  expect(confirmation.containers).toBe("unconfirmed");
});

test("only created, exited and dead containers count as not running", () => {
  const states = [
    "created",
    "exited",
    "dead",
    "running",
    "restarting",
    "paused",
    "removing",
    "something-new",
  ];
  expect(
    containersThatMayRun(states.map((state) => ({ name: state, state }))).map(
      (container) => container.state
    )
  ).toEqual(["running", "restarting", "paused", "removing", "something-new"]);
});

test("the listing selects by Compose project label across all states", async () => {
  const calls: (readonly string[])[] = [];
  const timeouts: number[] = [];
  const result = await listComposeProjectContainers({
    composeProject: PROJECT,
    timeoutMs: 2500,
    run: (cmd, opts) => {
      calls.push(cmd);
      timeouts.push(opts.timeoutMs);
      return Promise.resolve({
        exitCode: 0,
        stdout: `${line("demo--feat-a-api-1", "Exited")}\n${line("demo--feat-a-orphan-1", "running")}\n\n`,
        stderr: "",
      });
    },
  });
  expect(calls).toHaveLength(1);
  const [cmd] = calls;
  expect(cmd?.slice(0, 3)).toEqual(["docker", "ps", "--all"]);
  expect(cmd).toContain(`label=com.docker.compose.project=${PROJECT}`);
  // No Compose file or service list: orphans are included.
  expect(cmd).not.toContain("compose");
  expect(timeouts).toEqual([2500]);
  expect(result).toEqual({
    ok: true,
    containers: [
      { name: "demo--feat-a-api-1", state: "exited" },
      { name: "demo--feat-a-orphan-1", state: "running" },
    ],
  });
});

test("a failed, timed-out or throwing docker ps is not a listing", async () => {
  const outcomes = [
    [1, "docker ps failed (exit 1)"],
    [124, "docker ps timed out after 15000ms"],
  ] as const;
  for (const [exitCode, reason] of outcomes) {
    expect(
      await listComposeProjectContainers({
        composeProject: PROJECT,
        run: () =>
          Promise.resolve({
            exitCode,
            stdout: line("x", "exited"),
            stderr: "",
          }),
      })
    ).toEqual({ ok: false, reason });
  }
  expect(
    await listComposeProjectContainers({
      composeProject: PROJECT,
      run: () => Promise.reject(new Error("spawn docker ENOENT")),
    })
  ).toEqual({ ok: false, reason: "spawn docker ENOENT" });
  expect(parseComposeProjectContainers('{"name":"x"}\n').ok).toBe(false);
});
