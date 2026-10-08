import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeComposeProbe } from "../src/lib/native-compose-ownership.ts";
import { acquireProjectEnvForNativeExecution } from "../src/lib/project-env-config.ts";
import { createNativeRoutedDownProofWindow } from "./e2e/native-routed-down-proof-window.ts";
import {
  nativeRoutedDownChangedSource,
  nativeRoutedDownClaimsMatch,
  nativeRoutedDownFreshnessEvidence,
  nativeRoutedDownHookProofMatches,
  nativeRoutedDownMarkerProgram,
  nativeRoutedDownPhaseMatches,
  writeNativeRoutedDownEnvFixture,
} from "./e2e/scenarios/native-config-routed-down-hooks.ts";

const pin = {
  root: "/fixture/primary",
  marker: "synthetic-primary-marker",
  composeProject: "native-fixture",
  ownerToken: "a".repeat(32),
  generationId: "b".repeat(32),
  containers: ["c".repeat(64)],
  networks: ["d".repeat(64)],
  volume: { name: "native-fixture_state", createdAt: "2026-10-08T12:00:00Z" },
  origins: ["https://primary.test", "https://oauth.test"],
};
test("one routed hook's complete observations survive the old acquisition lifetime within the fixed outer window", async () => {
  const root = await mkdtemp(join(tmpdir(), "routed-proof-lifetime-"));
  const previous = process.env.PATH;
  const commands = join(root, "queries");
  const script = join(root, "docker");
  await Bun.write(
    script,
    `#!${process.execPath}
import {appendFileSync,writeFileSync} from "node:fs";
const args=process.argv.slice(2);
if(args.join(" ")!=="info --format {{.OSType}}") {writeFileSync(${JSON.stringify(join(root, "unexpected"))},"refused");process.exit(99);}
await Bun.sleep(20);
appendFileSync(${JSON.stringify(commands)},JSON.stringify(args)+"\\n");
console.log("linux");
`
  );
  await chmod(script, 0o700);
  process.env.PATH = root;
  const wallClock = spyOn(Date, "now").mockReturnValue(0);
  try {
    const args = ["info", "--format", "{{.OSType}}"];
    // This is the pre-fix hook's exact aggregate acquisition: it cannot be reused
    // for the later final inventory even when the outer proof window is open.
    const original = createNativeComposeProbe({ timeoutMs: 10_000 });
    expect((await original(args)).trim()).toBe("linux");
    const window = createNativeRoutedDownProofWindow({ timeoutMs: 30_000 });
    expect(window.deadline).toBe(30_000);
    expect(
      await window.capture(async (docker) => (await docker(args)).trim())
    ).toBe("linux");
    wallClock.mockReturnValue(10_001);
    await expect(original(args)).rejects.toMatchObject({
      code: "E_NATIVE_COMPOSE_PROBE_TIMEOUT",
    });
    expect(
      await window.capture(async (docker) => (await docker(args)).trim())
    ).toBe("linux");
    wallClock.mockReturnValue(29_000);
    expect(
      await window.capture(async (docker) => (await docker(args)).trim())
    ).toBe("linux");
    wallClock.mockReturnValue(30_000);
    await expect(window.capture(async (docker) => docker(args))).rejects.toThrow(
      "proof window expired"
    );
    expect(() => window.assertOpen()).toThrow("proof window expired");
    expect((await readFile(commands, "utf8")).trim().split("\n")).toHaveLength(
      4
    );
    expect(await Bun.file(join(root, "unexpected")).exists()).toBe(false);
  } finally {
    wallClock.mockRestore();
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "PATH");
    } else {
      process.env.PATH = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
});
test("routed observations use remaining outer time and never accept late or failed capture", async () => {
  let now = 0;
  const budgets: number[] = [];
  const window = createNativeRoutedDownProofWindow({
    timeoutMs: 30_000,
    now: () => now,
    createProbe: (opts) => {
      budgets.push(opts?.timeoutMs ?? -1);
      return () => Promise.resolve("synthetic-observation");
    },
  });
  await window.capture(async () => {
    now = 10_001;
  });
  await window.capture(async () => {
    now = 29_999;
  });
  await expect(
    window.capture(async () => {
      now = 30_000;
      return "must not be admitted";
    })
  ).rejects.toThrow("proof window expired");
  expect(budgets).toEqual([10_000, 10_000, 1]);
  await expect(window.capture(() => Promise.resolve())).rejects.toThrow(
    "proof window expired"
  );
  expect(budgets).toHaveLength(3);
  const failed = createNativeRoutedDownProofWindow({
    timeoutMs: 30_000,
    createProbe: () => () => Promise.resolve("synthetic-observation"),
  });
  const refusal = new Error("synthetic capture failed");
  await expect(failed.capture(() => Promise.reject(refusal))).rejects.toBe(refusal);
});
test("routed env authoring works after the native marker and preserves the actual env freshness fence", async () => {
  const created = await mkdtemp(join(tmpdir(), "native-routed-down-env-"));
  const root = await realpath(created);
  const envPath = join(root, ".hack", "hack.env.default.yaml");
  const selection = {
    projectRoot: root,
    overlay: null,
    inheritLocal: false,
    declaredWorkloadNames: ["web"],
    hostTargets: { includeDefault: true, workloadNames: [] },
  } as const;
  try {
    await mkdir(join(root, ".hack"));
    await Bun.write(join(root, ".hack", "hack.project.json"), "{}\n");
    await writeNativeRoutedDownEnvFixture({ root, mode: "initial" });
    const original = await Bun.file(envPath).text();
    const acquired = await acquireProjectEnvForNativeExecution(selection);
    const privateValues = await acquired.resolveValues();
    expect(privateValues.workloadEnv.web?.ROUTED_DOWN_TOKEN).toBe(
      "synthetic-routed-down-guest"
    );
    expect(privateValues.hostValues?.default?.ROUTED_DOWN_TOKEN).toBe(
      "synthetic-routed-down-host-$literal"
    );
    expect(JSON.stringify(acquired.metadata)).not.toContain(
      "synthetic-routed-down"
    );
    await acquired.assertFresh(selection);
    await expect(
      writeNativeRoutedDownEnvFixture({ root, mode: "initial" })
    ).rejects.toThrow("must not overwrite unrelated fixture inputs");
    expect(await Bun.file(envPath).text()).toBe(original);
    await writeNativeRoutedDownEnvFixture({ root, mode: "refresh" });
    await expect(acquired.assertFresh(selection)).rejects.toThrow(
      "selected inputs changed"
    );
    await expect(acquired.resolveValues()).rejects.toThrow(
      "selected inputs changed"
    );
    // A new command captures the refreshed current values; only the old acquisition is stale.
    const changed = await acquireProjectEnvForNativeExecution(selection);
    const changedValues = await changed.resolveValues();
    expect(changedValues.workloadEnv.web?.ROUTED_DOWN_TOKEN).toBe(
      "synthetic-routed-down-guest"
    );
    expect(changedValues.hostValues?.default?.ROUTED_DOWN_TOKEN).toBe(
      "synthetic-routed-down-host-$literal-refreshed"
    );
    await changed.assertFresh(selection);
    await writeNativeRoutedDownEnvFixture({ root, mode: "reset" });
    expect(await Bun.file(envPath).text()).toBe(original);
    await acquired.assertFresh(selection);
    await Bun.write(envPath, "unrelated fixture bytes\n");
    await expect(
      writeNativeRoutedDownEnvFixture({ root, mode: "refresh" })
    ).rejects.toThrow("must not overwrite unrelated fixture inputs");
    expect(await Bun.file(envPath).text()).toBe("unrelated fixture bytes\n");
  } finally {
    await rm(created, { recursive: true, force: true });
  }
});
test("saved-source control changes only the declared owned hook name", () => {
  const source = {
    version: 1,
    name: "fixture",
    services: { web: { image: "fixture-image" } },
    host: {
      down: {
        before: [
          {
            name: "routed-down-before",
            command: { exec: ["fixture-bun", "fixture-hook.ts", "before"] },
            environment: { SEEN: { env_ref: "ROUTED_DOWN_TOKEN" } },
          },
        ],
        after: [
          {
            name: "routed-down-after",
            command: { exec: ["fixture-bun", "fixture-hook.ts", "after"] },
          },
        ],
      },
    },
  };
  const changed = JSON.parse(
    nativeRoutedDownChangedSource(JSON.stringify(source))
  );
  expect(changed).toEqual({
    ...source,
    host: {
      down: {
        ...source.host.down,
        before: [
          { ...source.host.down.before[0], name: "changed-routed-down-before" },
        ],
      },
    },
  });
  for (const value of [
    {},
    { ...source, host: {} },
    { ...source, host: { down: { before: [] } } },
    changed,
  ]) {
    expect(() => nativeRoutedDownChangedSource(JSON.stringify(value))).toThrow(
      "exact owned before hook"
    );
  }
});
test("second routed startup refuses lost or changed marker without repairing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-routed-down-marker-"));
  const path = join(root, "marker");
  const execute = async (mode: "after17" | "success") => {
    const program = nativeRoutedDownMarkerProgram({
      mode,
      path,
      marker: pin.marker,
      primary: false,
    });
    const child = Bun.spawn([process.execPath, "-e", program], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: 1500,
    });
    return await child.exited;
  };
  try {
    expect(await execute("after17")).toBe(0);
    expect(await Bun.file(path).text()).toBe(pin.marker);
    const original = await stat(path);
    expect(await execute("success")).toBe(0);
    const retained = await stat(path);
    expect(retained.ino).toBe(original.ino);
    expect(retained.mtimeMs).toBe(original.mtimeMs);
    await rm(path);
    expect(await execute("success")).toBe(48);
    expect(await Bun.file(path).exists()).toBe(false);
    await Bun.write(path, "different-retained-bytes");
    expect(await execute("success")).toBe(48);
    expect(await Bun.file(path).text()).toBe("different-retained-bytes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
function observed(phase: "before" | "after" | "sibling") {
  return {
    pin: {
      ...pin,
      containers: phase === "after" ? [] : [...pin.containers],
      networks: phase === "after" ? [] : [...pin.networks],
    },
    pending:
      phase === "sibling"
        ? null
        : { operation: "down", generationId: pin.generationId },
    stopped: false,
    hostHookPhase: phase === "sibling" ? null : `down.${phase}`,
    beforeHooksPending: phase !== "sibling",
    marker: phase === "after" ? null : pin.marker,
  };
}
test("freshness refusal evidence identifies changed code, hook, state or claim without values", () => {
  const unchanged = observed("sibling");
  const opts = {
    expected: pin,
    observed: unchanged,
    inputErrorMatched: true,
    order: "",
    claimsBefore: "synthetic-claim-digest",
    claimsAfter: "synthetic-claim-digest",
  };
  const positive = {
    inputErrorMatched: true,
    hookOrderUnchanged: true,
    snapshotUnchanged: true,
    structuredSnapshotUnchanged: true,
    claimsUnchanged: true,
  };
  expect(nativeRoutedDownFreshnessEvidence(opts)).toEqual(positive);
  for (const [patch, field] of [
    [{ inputErrorMatched: false }, "inputErrorMatched"],
    [{ order: "before\n" }, "hookOrderUnchanged"],
    [{ claimsAfter: "changed-claim-digest" }, "claimsUnchanged"],
  ] as const) {
    expect(nativeRoutedDownFreshnessEvidence({ ...opts, ...patch })).toEqual({
      ...positive,
      [field]: false,
    });
  }
  for (const patch of [
    { pin: { ...pin, generationId: "e".repeat(32) } },
    { pin: { ...pin, containers: ["e".repeat(64)] } },
    { pending: { operation: "down", generationId: pin.generationId } },
    { stopped: true },
    { beforeHooksPending: true },
    { hostHookPhase: "down.before" },
    { marker: "wrong-retained-marker" },
  ]) {
    expect(
      nativeRoutedDownFreshnessEvidence({
        ...opts,
        observed: { ...unchanged, ...patch },
      })
    ).toEqual({
      ...positive,
      snapshotUnchanged: false,
      structuredSnapshotUnchanged: false,
    });
  }
  const permuted = {
    marker: unchanged.marker,
    pin: unchanged.pin,
    pending: unchanged.pending,
    stopped: unchanged.stopped,
    hostHookPhase: unchanged.hostHookPhase,
    beforeHooksPending: unchanged.beforeHooksPending,
  };
  expect(
    nativeRoutedDownFreshnessEvidence({ ...opts, observed: permuted })
  ).toEqual({ ...positive, snapshotUnchanged: false });
  expect(JSON.stringify(positive)).not.toContain(pin.marker);
  expect(JSON.stringify(positive)).not.toContain(pin.ownerToken);
});
test("routed down phases require exact pending generation and true before/after engine boundary", () => {
  for (const phase of ["before", "after", "sibling"] as const) {
    const actual = observed(phase);
    expect(
      nativeRoutedDownPhaseMatches({ expected: pin, observed: actual, phase })
    ).toBe(true);
    for (const patch of [
      { stopped: true },
      { pending: { operation: "up", generationId: pin.generationId } },
      { pending: { operation: "down", generationId: "e".repeat(32) } },
      { hostHookPhase: "down.unknown" },
      { beforeHooksPending: phase === "sibling" },
      { pin: { ...actual.pin, ownerToken: "e".repeat(32) } },
      { pin: { ...actual.pin, generationId: "f".repeat(32) } },
      {
        pin: {
          ...actual.pin,
          volume: { ...pin.volume, createdAt: "2026-10-08T12:01:00Z" },
        },
      },
      {
        pin: {
          ...actual.pin,
          origins: ["https://foreign.test", pin.origins[1]],
        },
      },
      { pin: { ...actual.pin, containers: ["short-id"] } },
      { pin: { ...actual.pin, containers: ["e".repeat(64), "e".repeat(64)] } },
      { pin: { ...actual.pin, networks: ["e".repeat(64), "e".repeat(64)] } },
    ]) {
      expect(
        nativeRoutedDownPhaseMatches({
          expected: pin,
          observed: { ...actual, ...patch },
          phase,
        })
      ).toBe(false);
    }
  }
  expect(
    nativeRoutedDownPhaseMatches({
      expected: pin,
      observed: observed("before"),
      phase: "after",
    })
  ).toBe(false);
  expect(
    nativeRoutedDownPhaseMatches({
      expected: pin,
      observed: observed("after"),
      phase: "before",
    })
  ).toBe(false);
  for (const value of [
    null,
    {},
    { pin },
    { ...observed("after"), pending: null },
    { ...observed("after"), beforeHooksPending: false },
  ]) {
    expect(
      nativeRoutedDownPhaseMatches({
        expected: pin,
        observed: value,
        phase: "after",
      })
    ).toBe(false);
  }
});
test("sibling proof refuses replacement IDs and wrong retained data even with the same owner", () => {
  const actual = observed("sibling");
  for (const patch of [
    { marker: "wrong-checkout-marker" },
    { marker: null },
    { pin: { ...actual.pin, containers: ["e".repeat(64)] } },
    { pin: { ...actual.pin, networks: ["e".repeat(64)] } },
    {
      pin: {
        ...actual.pin,
        volume: { ...pin.volume, name: "replacement-volume" },
      },
    },
    { hostHookPhase: "down.after", beforeHooksPending: true },
  ]) {
    expect(
      nativeRoutedDownPhaseMatches({
        expected: pin,
        observed: { ...actual, ...patch },
        phase: "sibling",
      })
    ).toBe(false);
  }
});
test("private hook proof must bind exact owner, generation, phase and observed engine membership", () => {
  for (const phase of ["before", "after"] as const) {
    const proof = {
      phase,
      generationId: pin.generationId,
      ownerToken: pin.ownerToken,
      containers: phase === "before" ? pin.containers : [],
      networks: phase === "before" ? pin.networks : [],
      heldClaims: true,
      siblingsUnchanged: true,
      ownerPending: true,
      routeState: phase === "before" ? "live" : "absent",
    };
    const match = (value: unknown) =>
      nativeRoutedDownHookProofMatches({ expected: pin, phase, proof: value });
    expect(match(proof)).toBe(true);
    for (const patch of [
      { ownerToken: "f".repeat(32) },
      { generationId: "f".repeat(32) },
      { phase: "unknown" },
      { heldClaims: false },
      { siblingsUnchanged: false },
      { ownerPending: false },
      { routeState: "unverified" },
      { containers: phase === "before" ? [] : pin.containers },
      { networks: phase === "before" ? [] : pin.networks },
      { extra: true },
    ]) {
      expect(match({ ...proof, ...patch })).toBe(false);
    }
    expect(match({ ...proof, containers: undefined })).toBe(false);
  }
});
function claim(host: string, digest = "a".repeat(64)): string {
  return `${createHash("sha256").update(host).digest("hex")}.json:${digest}`;
}
test("held claims cannot retire early; finalization removes only the two exact primary claims", () => {
  const own = [claim("primary.test"), claim("oauth.test")];
  const siblings = [
    "alpha.test",
    "oauth.alpha.test",
    "beta.test",
    "oauth.beta.test",
  ].map((host) => claim(host));
  const before = [...own, ...siblings].sort().join("\n");
  const after = [...siblings].sort().join("\n");
  const match = (observed: unknown, retired: boolean, original = before) =>
    nativeRoutedDownClaimsMatch({
      before: original,
      ownOrigins: pin.origins,
      observed,
      retired,
    });
  expect(match(before, false)).toBe(true);
  expect(match(after, true)).toBe(true);
  expect(match(after, false)).toBe(false);
  expect(match(before, true)).toBe(false);
  for (const incorrect of [
    "",
    undefined,
    after.split("\n").slice(1).join("\n"),
    `${after}\n${claim("foreign.test")}`,
    after.replace(/a{64}$/, "b".repeat(64)),
  ]) {
    expect(match(incorrect, true)).toBe(false);
  }
  for (const malformed of [
    before.replace(/a{64}$/, "bad"),
    [...own, ...siblings.slice(1), own[0]].sort().join("\n"),
    before.replace(own[0] ?? "", claim("foreign.test")),
  ]) {
    expect(match(after, true, malformed)).toBe(false);
  }
});
