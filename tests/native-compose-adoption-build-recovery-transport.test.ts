import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./e2e/harness.ts";
import {
  retainedBuildFixtureImage,
  retainedBuildFixtureMutationAllowed,
} from "./e2e/scenarios/native-compose-adoption-build-inputs.ts";
import { buildFixtureCli } from "./e2e/scenarios/native-compose-adoption-worktrees.ts";

const ID = "a".repeat(64);
const OTHER = "b".repeat(64);
const IMAGE = `sha256:${"c".repeat(64)}`;
const ANCHOR = {
  id: "e".repeat(32),
  manifest: { dev: 1, ino: 2, hash: "f".repeat(64) },
};
const PENDING_START = {
  adoption_receipt_version: 9,
  prepared: ANCHOR,
  publication: { phase: "active", generation: ANCHOR },
  pendingOperation: {
    generation: ANCHOR,
    operation: "start",
    services: ["db", "worker"],
  },
};
const RECOVER = ["down", "--recover", "--json"];

async function emitted(opts: {
  readonly cliArgs: string[];
  readonly receipt?: unknown;
  readonly effectArgs?: readonly string[];
  readonly observedEngineId?: string;
  readonly mutateCaller?: boolean;
}) {
  const outer = await realpath(
    await mkdtemp(join(tmpdir(), "retained-build-recovery-transport-"))
  );
  const root = join(outer, "checkout");
  const engine = join(outer, "synthetic-engine");
  const forwarded = join(outer, "forwarded");
  const saved = join(
    root,
    ".hack/.internal/legacy-compose-adoption-v1/receipt.json"
  );
  const instance = {
    root,
    name: "fixture",
    marker: "synthetic-sql-marker",
    basicBuild: "root-specific" as const,
  };
  try {
    await chmod(outer, 0o700);
    await mkdir(join(root, ".hack/.internal/legacy-compose-adoption-v1"), {
      mode: 0o700,
      recursive: true,
    });
    const before = JSON.stringify(opts.receipt ?? PENDING_START);
    await writeFile(saved, before, { mode: 0o600 });
    await writeFile(
      engine,
      [
        `#!${process.execPath}`,
        "import {appendFile} from 'node:fs/promises';",
        "const args=process.argv.slice(2);",
        `await appendFile(${JSON.stringify(forwarded)},JSON.stringify(args)+'\\n');`,
        `if(JSON.stringify(args)===JSON.stringify(['info','--format','{{json .ID}}'])){console.log(${JSON.stringify(opts.observedEngineId ?? "synthetic-daemon")});process.exit(0);}`,
        `if(JSON.stringify(args)===JSON.stringify(['container','stop',${JSON.stringify(ID)}]))process.exit(0);`,
        "process.exit(97);",
      ].join("\n"),
      { mode: 0o700 }
    );
    let captured: readonly string[] = [];
    const cli: Parameters<typeof buildFixtureCli>[0]["cli"] = async (
      selected,
      args,
      extra
    ) => {
      expect(selected).toBe(instance);
      captured = args;
      if (opts.mutateCaller) {
        opts.cliArgs.splice(0, opts.cliArgs.length, "up", "--detach", "--json");
      }
      return await runCommand({
        argv: ["docker", ...(opts.effectArgs ?? ["container", "stop", ID])],
        cwd: root,
        env: extra,
        timeoutMs: 5000,
      });
    };
    const result = await buildFixtureCli(
      {
        ctx: { tempRoot: outer },
        engine,
        engineId: "synthetic-daemon",
        baseImage: `sha256:${"1".repeat(64)}`,
        anchors: new Map([
          [
            instance,
            {
              source: "synthetic-original-source",
              resources: {
                container: [
                  { id: ID, service: "db" },
                  { id: OTHER, service: "worker" },
                ],
                network: [{ id: "d".repeat(64) }],
                volume: [{ id: "fixture_data" }],
              },
            },
          ],
        ]),
        builtImages: new Map([
          [
            instance,
            retainedBuildFixtureImage({
              value: {
                id: IMAGE,
                created: "2026-10-08T20:00:00.123456789Z",
                owner: "fixture",
                stage: "retained",
                tags: ["fixture-db:latest"],
                digests: null,
              },
              reference: "fixture-db",
              owner: "fixture",
              originalImageIds: [],
            }),
          ],
        ]),
        cli,
      },
      instance,
      opts.cliArgs
    );
    const calls: string[][] = (await Bun.file(forwarded).exists())
      ? (await readFile(forwarded, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
    return {
      result,
      calls,
      captured,
      before,
      after: await readFile(saved, "utf8"),
    };
  } finally {
    await rm(outer, { recursive: true, force: true });
  }
}

test("pending-start stop counterexample requires the explicit recovery capability and active original anchor", () => {
  const selection = {
    args: ["container", "stop", ID],
    receipt: PENDING_START,
    ids: [ID, OTHER],
    services: ["db", "worker"],
  };
  expect(retainedBuildFixtureMutationAllowed(selection)).toBe(false);
  expect(
    retainedBuildFixtureMutationAllowed({
      ...selection,
      recoverPendingStartStop: true,
    })
  ).toBe(true);
  for (const publication of [null, { phase: "prepared", generation: ANCHOR }]) {
    expect(
      retainedBuildFixtureMutationAllowed({
        ...selection,
        receipt: { ...PENDING_START, publication },
        recoverPendingStartStop: true,
      })
    ).toBe(false);
  }
});

test("emitted exact recovery-stop forwards only the journaled original ID without rewriting pending start", async () => {
  const observed = await emitted({ cliArgs: [...RECOVER], mutateCaller: true });
  expect(observed.captured).toEqual(RECOVER);
  expect(Object.isFrozen(observed.captured)).toBe(true);
  expect(observed.result.exitCode).toBe(0);
  expect(observed.result.timedOut).toBe(false);
  expect(observed.calls).toEqual([
    ["info", "--format", "{{json .ID}}"],
    ["container", "stop", ID],
  ]);
  expect(observed.after).toBe(observed.before);
});

for (const [name, cliArgs] of [
  ["ordinary", ["down", "--json"]],
  ["reordered", ["down", "--json", "--recover"]],
  ["extended", [...RECOVER, "--force"]],
] as const) {
  test(`emitted pending-start stop rejects an unissued ${name} recovery spelling`, async () => {
    const observed = await emitted({ cliArgs: [...cliArgs] });
    expect(observed.result.exitCode).toBe(94);
    expect(observed.result.stderr).toBe(
      "retained-build-refused stage=mutation-admission code=94\n"
    );
    expect(observed.calls).toEqual([]);
    expect(observed.after).toBe(observed.before);
  });
}

for (const [name, receipt] of [
  ["unpublished", { ...PENDING_START, publication: null }],
  [
    "foreign-generation",
    {
      ...PENDING_START,
      publication: {
        phase: "active",
        generation: { ...ANCHOR, id: "1".repeat(32) },
      },
    },
  ],
  [
    "partial-services",
    {
      ...PENDING_START,
      pendingOperation: { ...PENDING_START.pendingOperation, services: ["db"] },
    },
  ],
  ["foreign-version", { ...PENDING_START, adoption_receipt_version: 10 }],
] as const) {
  test(`emitted exact recovery-stop refuses ${name} before engine forwarding`, async () => {
    const observed = await emitted({ cliArgs: [...RECOVER], receipt });
    expect(observed.result.exitCode).toBe(94);
    expect(observed.calls).toEqual([]);
    expect(observed.after).toBe(observed.before);
  });
}

test("emitted exact recovery-stop refuses a foreign original ID and a changed daemon", async () => {
  const foreign = await emitted({
    cliArgs: [...RECOVER],
    effectArgs: ["container", "stop", "f".repeat(64)],
  });
  expect(foreign.result.exitCode).toBe(94);
  expect(foreign.calls).toEqual([]);
  const changed = await emitted({
    cliArgs: [...RECOVER],
    observedEngineId: "different-daemon",
  });
  expect(changed.result.exitCode).toBe(95);
  expect(changed.calls).toEqual([["info", "--format", "{{json .ID}}"]]);
  expect(changed.after).toBe(changed.before);
});

test("emitted ordinary journaled stop retains its previous admission", async () => {
  const observed = await emitted({
    cliArgs: ["down", "--json"],
    receipt: {
      ...PENDING_START,
      pendingOperation: {
        ...PENDING_START.pendingOperation,
        operation: "stop",
      },
    },
  });
  expect(observed.result.exitCode).toBe(0);
  expect(observed.calls).toEqual([
    ["info", "--format", "{{json .ID}}"],
    ["container", "stop", ID],
  ]);
  expect(observed.after).toBe(observed.before);
});
