import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HACK_VERSION } from "../src/lib/hack-version.ts";
import {
  parseRemoteChoices,
  readRemoteChoices,
  resolveRemoteChoices,
  runningRemoteIdentity,
  saveRemoteChoices,
} from "../src/lib/project-remote-selection.ts";
import { parseProjectPrerequisites } from "../src/lib/project-remotes-config.ts";

function declarations(confirm = false) {
  return {
    min_cli_version: HACK_VERSION,
    remotes: {
      db: {
        default: "local",
        env: { DB_HOST: "{host}" },
        targets: {
          local: { service: "postgres", port: 5432, confirm },
          qa: { hostname: "database.example.test", port: 5432 },
        },
      },
    },
  };
}

test("checkout choice loses to an explicit choice and defaults stay available", () => {
  const { selected } = parseProjectPrerequisites(declarations());
  expect(resolveRemoteChoices(selected, {}, {})).toMatchObject([
    { remote: "db", target: "local", source: "default" },
  ]);
  expect(resolveRemoteChoices(selected, { db: "qa" }, {})).toMatchObject([
    { remote: "db", target: "qa", source: "checkout" },
  ]);
  expect(
    resolveRemoteChoices(selected, { db: "qa" }, parseRemoteChoices("db=local"))
  ).toMatchObject([{ remote: "db", target: "local", source: "--use" }]);
  expect(() => parseRemoteChoices("db=local,db=qa")).toThrow();
  expect(() => resolveRemoteChoices(selected, {}, { db: "absent" })).toThrow();
});

test("a confirmation target cannot be the configured default", () => {
  expect(() => parseProjectPrerequisites(declarations(true))).toThrow(
    "cannot default to a target that requires confirmation"
  );
});

test("checkout save publishes only after the stopped check", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-use-selection-"));
  try {
    const first = join(root, "first");
    const second = join(root, "second");
    const { selected: defaults } = parseProjectPrerequisites(declarations());
    await expect(
      saveRemoteChoices({
        projectDir: first,
        defaults,
        changes: { db: "qa" },
        assertStopped: () => Promise.reject(new Error("active")),
      })
    ).rejects.toThrow("active");
    expect(await readRemoteChoices(first)).toEqual({});
    await saveRemoteChoices({
      projectDir: first,
      defaults,
      changes: { db: "qa" },
      assertStopped: () => Promise.resolve(),
    });
    expect(await readRemoteChoices(first)).toEqual({ db: "qa" });
    expect(await readRemoteChoices(second)).toEqual({});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active remote labels outrank stopped backing containers", () => {
  const stopped = ["exited", "dead", "created"].map((State) => ({
    State,
    Labels: "dev.hack.remote.db=local",
  }));
  expect(runningRemoteIdentity(stopped, "db")).toBe("local");
  expect(
    runningRemoteIdentity(
      [...stopped, { State: "created", Labels: "dev.hack.remote.db=qa" }],
      "db"
    )
  ).toBeUndefined();
  expect(
    runningRemoteIdentity(
      [...stopped, { State: "running", Labels: "dev.hack.remote.db=qa" }],
      "db"
    )
  ).toBe("qa");
});
