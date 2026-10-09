import {
  afterEach,
  beforeEach,
  test as boundedTest,
  expect,
  spyOn,
} from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNativeFileFixtureCommand as captureNativeFileFixtureCommand } from "./e2e/native-file-permission-command.ts";
import {
  nativeProtectedFileReadAllowed,
  nativeProtectedFileStartAllowed,
  nativeProtectedFileStateRefused,
  nativeProtectedFileToolAllowed,
} from "./e2e/native-file-permission-control.ts";
import {
  nativeFileFixtureNonowner,
  readNativeFileFixtureGuest,
} from "./e2e/native-file-permission-guest.ts";
import { createCompletedJobFixtureSettlement } from "./e2e/scenarios/native-compose-adoption-job-worktrees.ts";
import {
  nativeProtectedFileContainerIdentity,
  nativeProtectedFileRemovalMatches,
} from "./e2e/scenarios/native-config-protected-files.ts";

import { retainedRoutingFixtureLifetime } from "./helpers/retained-routing-adoption.ts";

let lifetime: ReturnType<typeof retainedRoutingFixtureLifetime> | undefined;
let uncertain = false;
let expectedUnknown = false;
let restorers: (() => void)[] = [];
function ownedTest(name: string, run: () => unknown, timeoutMs = 5000) {
  boundedTest(
    name,
    async () => {
      lifetime = retainedRoutingFixtureLifetime(Date.now() + timeoutMs);
      await lifetime.track(Promise.resolve().then(run));
    },
    timeoutMs
  );
}
const test = Object.assign(ownedTest, {
  each:
    <T>(rows: readonly T[]) =>
    (name: string, run: (value: T) => unknown) => {
      for (const value of rows) {
        ownedTest(name.replace("%s", String(value)), () => run(value));
      }
    },
  skipIf: (skip: boolean) => (skip ? boundedTest.skip : ownedTest),
});
function runNativeFileFixtureCommand(
  opts: Parameters<typeof captureNativeFileFixtureCommand>[0]
) {
  if (!lifetime) {
    throw new Error("Fixture lifetime missing; values omitted.");
  }
  const owner = lifetime;
  return owner.track(
    captureNativeFileFixtureCommand({
      ...opts,
      onUnconfirmed: () => {
        owner.retain();
        opts.onUnconfirmed?.();
      },
    })
  );
}

const grants = [
  { target: "/settings", mode: "0444" as const, bytes: [1] },
  { target: "/run/secrets/owner", mode: "0400" as const, bytes: [2] },
  { target: "/run/secrets/private", mode: "0600" as const, bytes: [3] },
];
const observed = {
  version: 1,
  marker: "granted-files-exact",
  uid: 123,
  gid: 456,
  members: grants.map((row) => ({
    target: row.target,
    mode: row.mode,
    uid: 234,
    gid: 345,
  })),
};
test("guest permission decoder binds explicit modes and observed owner/process IDs without returning content", () => {
  const value = readNativeFileFixtureGuest({
    text: JSON.stringify(observed),
    expected: grants,
  });
  expect(value.uid).toBe(123);
  expect(value.members.map((row) => row.mode)).toEqual([
    "0444",
    "0400",
    "0600",
  ]);
  expect(nativeFileFixtureNonowner(value)).toBe(65_534);
  expect(JSON.stringify(value)).not.toContain('"bytes"');
});
test.each([
  "mode",
  "target",
  "uid",
  "extra",
  "missing",
  "order",
])("guest permission decoder refuses %s", (kind) => {
  const value = structuredClone(observed);
  if (kind === "mode") {
    value.members[1]!.mode = "0444";
  } else if (kind === "target") {
    value.members[1]!.target = "/foreign";
  } else if (kind === "uid") {
    value.members[1]!.uid = -1;
  } else if (kind === "extra") {
    Object.assign(value, { bytes: [2] });
  } else if (kind === "missing") {
    value.members.pop();
  } else {
    value.members.reverse();
  }
  expect(() =>
    readNativeFileFixtureGuest({
      text: JSON.stringify(value),
      expected: grants,
    })
  ).toThrow();
});
const ids = ["a".repeat(64), "b".repeat(64), "c".repeat(64)],
  prepared = {
    id: "d".repeat(32),
    manifest: { dev: 1, ino: 2, hash: "e".repeat(64) },
  };
test("source refusal requires the exact closed redacted state code and message", () => {
  const value = {
    ok: false,
    error: {
      code: "E_CONFIG_INVALID",
      message:
        "Legacy adoption generation state is invalid, unsafe or changed; values omitted.",
    },
  };
  expect(nativeProtectedFileStateRefused(value)).toBe(true);
  for (const row of [
    { ...value, ok: true },
    { ...value, error: { ...value.error, code: "E_STARTUP_INCOMPLETE" } },
    {
      ...value,
      error: { ...value.error, message: "arbitrary source refusal" },
    },
    Object.create(value),
  ]) {
    expect(nativeProtectedFileStateRefused(row)).toBe(false);
  }
});
const receipt = {
  adoption_receipt_version: 8,
  prepared,
  publication: { phase: "active", generation: prepared },
  pendingOperation: {
    operation: "start",
    generation: prepared,
    services: ["db", "reader", "ungranted"],
  },
};
test("interrupted start marker requires the real whole original-ID pending selection", () =>
  expect(
    nativeProtectedFileStartAllowed({
      args: ["container", "start", ...ids],
      ids,
      prepared,
      receipt,
    })
  ).toBe(true));
test.each([
  "no-pending",
  "foreign-generation",
  "wrong-operation",
  "wrong-role",
  "extra-id",
  "force",
  "duplicate-id",
])("interrupted start refuses %s before effects", (kind) => {
  const value: Record<string, unknown> = structuredClone(receipt);
  const args = ["container", "start", ...ids];
  if (kind === "no-pending") {
    value.pendingOperation = null;
  } else if (kind === "foreign-generation") {
    value.prepared = { ...prepared, id: "f".repeat(32) };
  } else if (kind === "wrong-operation") {
    value.pendingOperation = { ...receipt.pendingOperation, operation: "stop" };
  } else if (kind === "wrong-role") {
    value.pendingOperation = {
      ...receipt.pendingOperation,
      services: ["db", "reader", "foreign"],
    };
  } else if (kind === "extra-id") {
    args.push("f".repeat(64));
  } else if (kind === "force") {
    args.splice(2, 0, "--force");
  } else {
    args[3] = ids[0]!;
  }
  expect(
    nativeProtectedFileStartAllowed({ args, ids, prepared, receipt: value })
  ).toBe(false);
});
const scope = {
  projectRoot: "/fixture",
  project: "fixture",
  containerIds: ids,
  networkId: "e".repeat(64),
  volumeName: "fixture_data",
  generationId: "f".repeat(32),
  reader: ids[1]!,
  targets: ["/settings"],
};
test("closed forwarder permits fixed proof stat/hash and rejects content or other effects", () => {
  expect(
    nativeProtectedFileReadAllowed({
      ...scope,
      args: [
        "exec",
        scope.reader,
        "stat",
        "-c",
        "%d:%i:%u:%g:%s:%f:%a",
        "--",
        "/settings",
      ],
    })
  ).toBe(true);
  expect(
    nativeProtectedFileReadAllowed({
      ...scope,
      args: ["exec", scope.reader, "sha256sum", "--", "/settings"],
    })
  ).toBe(true);
  for (const args of [
    ["exec", scope.reader, "cat", "/settings"],
    ["exec", ids[0]!, "sha256sum", "--", "/settings"],
    ["exec", scope.reader, "sha256sum", "--", "/foreign"],
    ["container", "rm", "--force", scope.reader],
    ["compose", "up"],
  ]) {
    expect(nativeProtectedFileReadAllowed({ ...scope, args })).toBe(false);
  }
});
const pin = {
  id: ids[0],
  createdAt: "2026-01-01T00:00:00Z",
  image: `sha256:${ids[2]}`,
  labels: { project: "fixture" },
  entrypoint: ["sh", "-c"],
  command: ["first", "second"],
  mounts: [
    { type: "bind", source: "/fixture/secret", target: "/secret", rw: false },
    {
      type: "bind",
      source: "/fixture/settings",
      target: "/settings",
      rw: false,
    },
  ],
  networks: [{ name: "fixture_default", id: ids[1] }],
  running: true,
  paused: false,
  status: "running",
};
test("stopped cleanup preserves full immutable facts and argv order", () => {
  const stopped = { ...pin, running: false, status: "exited" };
  expect(
    nativeProtectedFileRemovalMatches({
      kind: "container",
      pin,
      current: stopped,
    })
  ).toBe(true);
  for (const value of [
    { ...stopped, running: true },
    { ...stopped, createdAt: "2027-01-01" },
    { ...stopped, id: ids[1] },
    { ...stopped, command: ["second", "first"] },
    { ...stopped, mounts: [{ ...pin.mounts[0], rw: true }, pin.mounts[1]] },
    { ...stopped, networks: [{ name: "foreign", id: ids[1] }] },
  ]) {
    expect(
      nativeProtectedFileRemovalMatches({
        kind: "container",
        pin,
        current: value,
      })
    ).toBe(false);
  }
  expect(
    nativeProtectedFileRemovalMatches({
      kind: "container",
      pin,
      current: { ...stopped, mounts: [...stopped.mounts].reverse() },
    })
  ).toBe(true);
  expect(
    nativeProtectedFileContainerIdentity({
      ...pin,
      mounts: [...pin.mounts].reverse(),
    })
  ).toBe(nativeProtectedFileContainerIdentity(pin));
});
let directory: string;
beforeEach(async () => {
  if (uncertain) {
    throw new Error("Prior fixture lifetime is unknown; values omitted.");
  }
  lifetime = undefined;
  expectedUnknown = false;
  restorers = [];
  directory = await realpath(
    await mkdtemp(join(tmpdir(), "protected-command-"))
  );
});
afterEach(async () => {
  if (!lifetime?.canRestore()) {
    uncertain = true;
    if (expectedUnknown) {
      // The last intentional-unknown case asserts retention; it never releases teardown.
      return;
    }
    throw new Error(
      "Fixture callback/child is unsettled; root and globals retained, values omitted."
    );
  }
  for (const restore of restorers) {
    restore();
  }
  await rm(directory, { recursive: true, force: true });
});
test("bounded command privately delivers stdin and captures a known nonzero unchanged", async () => {
  const result = await runNativeFileFixtureCommand({
    argv: [
      process.execPath,
      "-e",
      'const text=await Bun.stdin.text();if(text!=="fixture-only")process.exit(99);console.log("stdin-verified");process.exit(17)',
    ],
    cwd: directory,
    env: { PATH: process.env.PATH ?? "" },
    stdin: Buffer.from("fixture-only"),
    timeoutMs: 1000,
    capturePrefix: join(directory, "result"),
  });
  expect(result.exitCode).toBe(17);
  expect(result.stdout.trim()).toBe("stdin-verified");
  expect(await readFile(join(directory, "result.json"), "utf8")).not.toContain(
    "fixture-only"
  );
});
test("caller mutation cannot retarget capture or change an admitted invocation", async () => {
  const foreign = join(directory, "foreign");
  await mkdir(foreign, { mode: 0o700 });
  const wrong = join(directory, "wrong-child"),
    input = Buffer.from("captured-input"),
    signal = new AbortController();
  const script = `const bytes=await Bun.stdin.text();if(bytes!=="captured-input"||process.env.SELECTED!=="original"||process.cwd()!==${JSON.stringify(directory)})process.exit(99);await Bun.sleep(150);console.log("captured-selection");process.exit(17)`;
  const opts = {
    argv: [process.execPath, "-e", script],
    cwd: directory,
    env: { PATH: process.env.PATH ?? "", SELECTED: "original" },
    timeoutMs: 1000,
    signal: signal.signal,
    stdin: input,
    capturePrefix: join(directory, "captured"),
  };
  const pending = runNativeFileFixtureCommand(opts);
  opts.argv.splice(
    0,
    opts.argv.length,
    process.execPath,
    "-e",
    `await Bun.write(${JSON.stringify(wrong)},"wrong")`
  );
  opts.env.SELECTED = "changed";
  opts.cwd = foreign;
  opts.timeoutMs = 1;
  input.fill(120);
  opts.capturePrefix = join(foreign, "redirected");
  const other = new AbortController();
  other.abort();
  opts.signal = other.signal;
  const result = await pending;
  expect(result.exitCode).toBe(17);
  expect(result.stdout.trim()).toBe("captured-selection");
  expect(await Bun.file(join(directory, "captured.json")).exists()).toBe(true);
  expect(await Bun.file(join(foreign, "redirected.stdout")).exists()).toBe(
    false
  );
  expect(await Bun.file(wrong).exists()).toBe(false);
});
test("external cancellation settles a live leader within the existing owner and cannot qualify a late success", async () => {
  const pidPath = join(directory, "cancelled-leader"),
    controller = new AbortController();
  const prefix = join(directory, "cancelled");
  const pending = runNativeFileFixtureCommand({
    argv: [
      process.execPath,
      "-e",
      `await Bun.write(${JSON.stringify(pidPath)},String(process.pid));await Bun.sleep(5000)`,
    ],
    cwd: directory,
    env: {},
    timeoutMs: 1000,
    signal: controller.signal,
    capturePrefix: prefix,
  });
  try {
    const deadline = Date.now() + 500;
    while (!(await Bun.file(pidPath).exists())) {
      expect(Date.now()).toBeLessThan(deadline);
      await Bun.sleep(5);
    }
    controller.abort();
    await expect(pending).rejects.toThrow();
    const pid = Number(await readFile(pidPath, "utf8"));
    try {
      process.kill(pid, 0);
      throw new Error("captured leader remains");
    } catch (error: unknown) {
      expect((error as { code: string }).code).toBe("ESRCH");
    }
    const receipt = JSON.parse(
      await readFile(`${prefix}.settlement.json`, "utf8")
    );
    expect(receipt.interrupted).toBe(true);
    expect(receipt.capturedGroupAbsent).toBe(true);
    expect(await Bun.file(`${prefix}.json`).exists()).toBe(false);
  } finally {
    controller.abort();
    await pending.catch(() => undefined);
  }
});
test("capture overflow cancels and reaps an owned sleeping leader", async () => {
  const pidPath = join(directory, "leader");
  await expect(
    runNativeFileFixtureCommand({
      argv: [
        process.execPath,
        "-e",
        `await Bun.write(${JSON.stringify(pidPath)},String(process.pid));try{await Bun.write(Bun.stdout,'x'.repeat(300000))}catch{};await Bun.sleep(5000)`,
      ],
      cwd: directory,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 1000,
    })
  ).rejects.toThrow();
  const pid = Number(await readFile(pidPath, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
  try {
    process.kill(pid, 0);
  } catch (error: unknown) {
    expect((error as { code: string }).code).toBe("ESRCH");
  }
});
test("capture publication conflict refuses before spawn without any group signal", async () => {
  const prefix = join(directory, "publication");
  await writeFile(`${prefix}.stdout`, "keep-existing", {
    flag: "wx",
    mode: 0o600,
  });
  const original = process.kill,
    groups: number[] = [];
  const signal = spyOn(process, "kill").mockImplementation((pid, kind) => {
    if (pid < 0 && kind !== 0) {
      groups.push(pid);
    }
    return original.call(process, pid, kind);
  });
  restorers.push(() => signal.mockRestore());
  await expect(
    runNativeFileFixtureCommand({
      argv: [process.execPath, "-e", 'console.log("complete")'],
      cwd: directory,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 1000,
      capturePrefix: prefix,
    })
  ).rejects.toThrow();
  expect(groups).toEqual([]);
  expect(await readFile(`${prefix}.stdout`, "utf8")).toBe("keep-existing");
  expect(await Bun.file(`${prefix}.json`).exists()).toBe(false);
});
test("pre-cancelled command refuses before spawning or publishing", async () => {
  const marker = join(directory, "never"),
    controller = new AbortController();
  controller.abort();
  await expect(
    runNativeFileFixtureCommand({
      argv: [
        process.execPath,
        "-e",
        `await Bun.write(${JSON.stringify(marker)},"unexpected")`,
      ],
      cwd: directory,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: 1000,
      signal: controller.signal,
    })
  ).rejects.toThrow();
  expect(await Bun.file(marker).exists()).toBe(false);
});

const systemGit = {
  role: "git" as const,
  platform: "darwin",
  selected: "/usr/bin/git",
  physical: "/usr/bin/git",
  regular: true,
  symlink: false,
  uid: 0,
  mode: 0o755,
  nlink: 78,
};
test("canonical root-owned Darwin Git admits positive shared links while private and alternate tools stay single-link", () => {
  expect(nativeProtectedFileToolAllowed(systemGit)).toBe(true);
  expect(
    nativeProtectedFileToolAllowed({ ...systemGit, role: "artifact", nlink: 1 })
  ).toBe(true);
  for (const changed of [
    { role: "artifact" as const },
    { platform: "linux" },
    { selected: "/tmp/git" },
    { physical: "/tmp/git" },
    { uid: 123 },
    { mode: 0o775 },
    { mode: 0o777 },
    { mode: 0o644 },
    { nlink: 0 },
    { nlink: -1 },
    { nlink: Number.NaN },
    { nlink: 1.5 },
    { regular: false },
    { symlink: true },
  ]) {
    expect(nativeProtectedFileToolAllowed({ ...systemGit, ...changed })).toBe(
      false
    );
  }
});
test.skipIf(process.platform !== "darwin")(
  "canonical OS Git filesystem correspondence preserves the old single-link RED",
  async () => {
    const info = await lstat("/usr/bin/git"),
      physical = await realpath("/usr/bin/git");
    expect(
      nativeProtectedFileToolAllowed({
        role: "git",
        platform: process.platform,
        selected: "/usr/bin/git",
        physical,
        regular: info.isFile(),
        symlink: info.isSymbolicLink(),
        uid: info.uid,
        mode: info.mode,
        nlink: info.nlink,
      })
    ).toBe(true);
    expect(info.uid).toBe(0);
    expect(info.mode & 0o022).toBe(0);
    if (info.nlink > 1) {
      expect(info.nlink === 1).toBe(false);
    }
  }
);

// This intentional-unknown negative is last: its root and global spy remain retained until process exit.
test("closed-pipe survivor refuses completion and permanently vetoes restoration without a former-group signal", async () => {
  const pidPath = join(directory, "descendant"),
    child = join(directory, "child.ts"),
    prefix = join(directory, "survivor");
  await writeFile(
    child,
    `await Bun.write(${JSON.stringify(pidPath)},String(process.pid));await Bun.sleep(1500);`
  );
  const settlement = createCompletedJobFixtureSettlement();
  const original = process.kill.bind(process),
    groups: number[] = [];
  const signal = spyOn(process, "kill").mockImplementation((pid, kind) => {
    if (pid < 0 && kind !== 0) {
      groups.push(pid);
    }
    return original(pid, kind);
  });
  restorers.push(() => signal.mockRestore());
  let descendant: number | undefined;
  let descendantJoined = false;
  const waitForDescendant = async () => {
    descendant = Number(await readFile(pidPath, "utf8"));
    expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true);
    const deadline = Date.now() + 2500;
    while (true) {
      try {
        original(descendant, 0);
      } catch (error: unknown) {
        expect((error as { code: string }).code).toBe("ESRCH");
        return;
      }
      expect(Date.now()).toBeLessThan(deadline);
      await Bun.sleep(10);
    }
  };
  try {
    await expect(
      runNativeFileFixtureCommand({
        argv: [
          process.execPath,
          "-e",
          `Bun.spawn([${JSON.stringify(process.execPath)},${JSON.stringify(child)}],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});while(!await Bun.file(${JSON.stringify(pidPath)}).exists())await Bun.sleep(5);process.exit(0)`,
        ],
        cwd: directory,
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 1000,
        capturePrefix: prefix,
        onUnconfirmed: settlement.markUnconfirmed,
      })
    ).rejects.toThrow();
    descendant = Number(await readFile(pidPath, "utf8"));
    expect(original(descendant, 0)).toBe(true);
    expect(await Bun.file(`${prefix}.json`).exists()).toBe(false);
    expect(await Bun.file(`${prefix}.settlement.json`).exists()).toBe(false);
    let restoration = 0;
    expect(() => {
      settlement.assertConfirmed();
      restoration += 1;
    }).toThrow();
    expect(restoration).toBe(0);
    expect(groups).toEqual([]);
    await waitForDescendant();
    expect(() => settlement.assertConfirmed()).toThrow();
    expect(groups).toEqual([]);
  } finally {
    // Only an exact finite self-join can release this test's root/global teardown.
    await lifetime!.track(waitForDescendant()).then(
      () => {
        descendantJoined = true;
      },
      () => lifetime!.retain()
    );
  }
  expect(descendantJoined).toBe(true);
  expect(lifetime!.canRestore()).toBe(false);
  expectedUnknown = true;
});
