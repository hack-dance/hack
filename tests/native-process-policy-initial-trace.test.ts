import { expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNativeComposeOwned,
  type NativeComposeOwnershipOptions,
} from "../src/lib/native-compose-ownership.ts";
import { exec } from "../src/lib/shell.ts";
import {
  persistProcessPolicyFirstAfterComposeRefusal,
  replayProcessPolicyInitialOwnership,
} from "./e2e/native-process-policy-initial-replay.ts";
import {
  type ProcessPolicyInitialTraceQuery,
  prepareProcessPolicyInitialTrace,
  processPolicyInitialTraceFormats,
  processPolicyInitialTraceQuery,
  readProcessPolicyInitialTrace,
} from "./e2e/native-process-policy-initial-trace.ts";
import { restoreEnv } from "./helpers/env.ts";

const CANARY = "synthetic-unknown-docker-stdout-stderr-canary";
const id = "c".repeat(64);
const networkId = "d".repeat(64);
const owner = "a".repeat(32);
const generation = "b".repeat(32);
const project = "process-fixture";
const selection: NativeComposeOwnershipOptions = {
  composeProject: project,
  runtimeIdentity: project,
  ownerToken: owner,
  generationIds: [generation],
  expectedServices: ["retry"],
  expectedVolumes: [{ name: "process-fixture_evidence", storage: "evidence" }],
  expectedNetwork: `${project}_default`,
};

function list(kind: "container" | "volume" | "network"): string[] {
  return [
    kind,
    "ls",
    ...(kind === "container" ? ["--all"] : []),
    ...(kind === "volume" ? [] : ["--no-trunc"]),
    "--format",
    processPolicyInitialTraceFormats[kind].list,
  ];
}
function inspect(kind: "container" | "volume" | "network"): string[] {
  return [
    kind,
    "inspect",
    "--format",
    processPolicyInitialTraceFormats[kind].inspect,
    kind === "volume"
      ? "process-fixture_evidence"
      : kind === "container"
        ? id
        : networkId,
  ];
}

test("initial trace accepts only exact ownership read protocols", () => {
  for (const kind of ["container", "volume", "network"] as const) {
    expect(processPolicyInitialTraceQuery(list(kind))).toEqual({
      kind,
      action: "ls",
    });
    const args = [
      kind,
      "inspect",
      "--format",
      processPolicyInitialTraceFormats[kind].inspect,
      kind === "volume" ? "fixture_evidence" : id,
    ];
    expect(processPolicyInitialTraceQuery(args)).toEqual({
      kind,
      action: "inspect",
    });
    expect(processPolicyInitialTraceQuery([...args, args[4] ?? ""])).toBeNull();
  }
  for (const args of [
    ["inspect", id],
    ["container", "inspect", "--format", "{{json .Config.Env}}", id],
    [...list("container"), "--filter", "label=private"],
    ["container", "rm", id],
    ["compose", "up", "-d"],
  ]) {
    expect(processPolicyInitialTraceQuery(args)).toBeNull();
  }
});

test("initial forwarding preserves bytes/exits but records no unknown output, args or stderr", async () => {
  const root = await mkdtemp(join(tmpdir(), "process-initial-forwarding-"));
  const previous = process.env.PATH;
  const binary = join(root, "docker");
  const traceRoot = join(root, "trace");
  try {
    await Bun.write(
      binary,
      `#!${process.execPath} --no-env-file
const args=process.argv.slice(2); await Bun.sleep(20);
if(args[0]==="compose"){await Bun.write(Bun.stdout,"original compose bytes\\n");await Bun.write(Bun.stderr,${JSON.stringify(CANARY)});process.exit(17);}
if(args[1]==="ls"){await Bun.write(Bun.stdout,"original list bytes\\n");process.exit(0);}
await Bun.write(Bun.stdout,${JSON.stringify(CANARY)});await Bun.write(Bun.stderr,${JSON.stringify(CANARY)});process.exit(23);
`
    );
    await chmod(binary, 0o700);
    process.env.PATH = root;
    const prepared = await prepareProcessPolicyInitialTrace({
      directory: traceRoot,
    });
    const run = async (args: readonly string[]) =>
      await exec([join(traceRoot, "docker"), ...args], {
        env: { PATH: prepared.path },
        stdin: "ignore",
        timeoutMs: 3000,
      });
    expect(await run(list("container"))).toEqual({
      exitCode: 0,
      stdout: "original list bytes\n",
      stderr: "",
    });
    expect(
      await run(["compose", "-p", project, "-f", CANARY, "up", "-d"])
    ).toEqual({
      exitCode: 17,
      stdout: "original compose bytes\n",
      stderr: CANARY,
    });
    expect(
      await run(["inspect", id, "--format", "{{json .Config.Env}}"])
    ).toEqual({ exitCode: 23, stdout: CANARY, stderr: CANARY });
    expect(await run(list("network"))).toEqual({
      exitCode: 0,
      stdout: "original list bytes\n",
      stderr: "",
    });
    const trace = await readProcessPolicyInitialTrace(prepared.directory);
    expect(trace.queries.map((row) => row.args)).toEqual([
      list("container"),
      list("network"),
    ]);
    expect((trace.queries[0]?.startOrder ?? -1) < trace.upStartOrder).toBe(
      true
    );
    expect((trace.queries[1]?.startOrder ?? -1) > trace.upReapOrder).toBe(true);
    for (const name of await readdir(prepared.directory)) {
      expect(
        await Bun.file(join(prepared.directory, name)).text()
      ).not.toContain(CANARY);
    }
    const journal = join(prepared.directory, "events.jsonl");
    const originalJournal = await Bun.file(journal).text();
    const second = trace.queries[1];
    const first = trace.queries[0];
    if (!(first && second)) {
      throw new Error("Missing synthetic query pair");
    }
    // Complete but overlapping original reads cannot be grouped into a faithful
    // single-owner replay, even if every capsule and reply is still present.
    const effect = originalJournal
      .trimEnd()
      .split("\n")
      .filter(
        (line) => !(line.includes(first.token) || line.includes(second.token))
      );
    const overlapping = [
      { token: first.token, event: "start" },
      { token: second.token, event: "start" },
      { token: first.token, event: "reap" },
      { token: second.token, event: "reap" },
    ].map((event) => JSON.stringify(event));
    await Bun.write(journal, `${[...overlapping, ...effect].join("\n")}\n`);
    await expect(
      readProcessPolicyInitialTrace(prepared.directory)
    ).rejects.toThrow("trace unavailable");
    await Bun.write(journal, originalJournal.slice(0, -1));
    await expect(
      readProcessPolicyInitialTrace(prepared.directory)
    ).rejects.toThrow("trace unavailable");
    await Bun.write(journal, originalJournal);
    expect(
      (await readProcessPolicyInitialTrace(prepared.directory)).queries.map(
        (row) => row.args
      )
    ).toEqual([list("container"), list("network")]);
    const row = trace.queries[0];
    if (!row) {
      throw new Error("Missing synthetic trace");
    }
    const reap = join(prepared.directory, `${row.token}.json.reap`);
    const originalReap = await Bun.file(reap).text();
    await unlink(reap);
    await expect(
      readProcessPolicyInitialTrace(prepared.directory)
    ).rejects.toThrow();
    await Bun.write(reap, originalReap);
    await unlink(join(prepared.directory, `${row.token}.json.start`));
    await expect(
      readProcessPolicyInitialTrace(prepared.directory)
    ).rejects.toThrow();
  } finally {
    restoreEnv("PATH", previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("initial forwarding preserves a multicall Docker entry and refuses its replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "process-initial-entry-"));
  const previous = process.env.PATH;
  const target = join(root, "docker-tools");
  const entry = join(root, "docker");
  const traceRoot = join(root, "trace");
  try {
    // The target alone is not the selected command: argv0 determines its operation.
    await Bun.write(
      target,
      `#!/bin/sh\nif [ "$0" != '${entry}' ]; then exit 79; fi\nprintf '%s' entry-preserved\n`
    );
    await chmod(target, 0o700);
    await symlink(target, entry);
    process.env.PATH = root;
    expect(
      (await exec([target], { stdin: "ignore", timeoutMs: 3000 })).exitCode
    ).toBe(79);
    const prepared = await prepareProcessPolicyInitialTrace({
      directory: traceRoot,
    });
    const run = async () =>
      await exec([join(traceRoot, "docker"), "version"], {
        env: { PATH: prepared.path },
        stdin: "ignore",
        timeoutMs: 3000,
      });
    expect(await run()).toEqual({
      exitCode: 0,
      stdout: "entry-preserved",
      stderr: "",
    });
    await unlink(entry);
    await symlink(target, entry);
    const replaced = await run();
    expect(replaced.exitCode).not.toBe(0);
    expect(replaced.stdout).toBe("");
    expect(replaced.stderr).toContain("trace unavailable; values omitted");
  } finally {
    restoreEnv("PATH", previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed UTF-8 keeps the caller's exact bytes/exit and makes replay unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "process-initial-utf8-"));
  const previous = process.env.PATH;
  const target = join(root, "docker");
  const traceRoot = join(root, "trace");
  const bytes = new Uint8Array([
    123, 34, 105, 103, 110, 111, 114, 101, 100, 34, 58, 34, 255, 34, 125,
  ]);
  try {
    await Bun.write(
      target,
      `#!${process.execPath} --no-env-file\nawait Bun.write(Bun.stdout,new Uint8Array(${JSON.stringify([...bytes])}));\n`
    );
    await chmod(target, 0o700);
    process.env.PATH = root;
    const prepared = await prepareProcessPolicyInitialTrace({
      directory: traceRoot,
    });
    const child = Bun.spawn([join(traceRoot, "docker"), ...list("container")], {
      env: { ...process.env, PATH: prepared.path },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const actual = new Uint8Array(
      await new Response(child.stdout).arrayBuffer()
    );
    expect(await child.exited).toBe(0);
    expect(actual).toEqual(bytes);
    expect(await new Response(child.stderr).text()).toBe("");
    process.env.PATH = prepared.path;
    await expect(
      assertNativeComposeOwned({ ...selection, timeoutMs: 3000 })
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_PROBE" });
    await expect(
      readProcessPolicyInitialTrace(prepared.directory)
    ).rejects.toThrow("trace unavailable; values omitted");
    for (const name of await readdir(prepared.directory)) {
      expect(
        await Bun.file(join(prepared.directory, name)).text()
      ).not.toContain("�");
    }
  } finally {
    restoreEnv("PATH", previous);
    await rm(root, { recursive: true, force: true });
  }
});

test("trace replay exposes startup vs strict ownership without accepting a truncated or changed protocol", async () => {
  const root = await mkdtemp(join(tmpdir(), "process-initial-replay-"));
  const container = {
    id,
    name: `/${project}-retry-1`,
    project,
    version: "1",
    instance: project,
    owner,
    generation,
    service: "retry",
    oneoff: "False",
    state: "restarting",
    exitCode: 17,
    health: null,
    networks: {
      [`${project}_default`]: {
        NetworkID: networkId,
        Aliases: [`${project}-retry-1`, "retry"],
      },
    },
  };
  const network = {
    id: networkId,
    name: `${project}_default`,
    project,
    version: "1",
    instance: project,
    owner,
    driver: "bridge",
    internal: false,
    containers: {},
  };
  const volume = {
    id: "process-fixture_evidence",
    name: "process-fixture_evidence",
    project,
    version: "1",
    instance: project,
    owner,
    storage: "evidence",
    createdAt: "2026-10-08T12:00:00Z",
  };
  const volumeList = JSON.stringify({
    id: volume.id,
    name: volume.name,
    project,
  });
  const calls: [string[], string][] = [
    [
      list("container"),
      JSON.stringify({ id, name: `${project}-retry-1`, project }),
    ],
    [inspect("container"), JSON.stringify(container)],
    [list("volume"), volumeList],
    [inspect("volume"), JSON.stringify(volume)],
    [
      list("network"),
      JSON.stringify({ id: networkId, name: `${project}_default`, project }),
    ],
    [inspect("network"), JSON.stringify(network)],
    [inspect("container"), JSON.stringify(container)],
    [inspect("volume"), JSON.stringify(volume)],
    [inspect("network"), JSON.stringify(network)],
    [
      list("container"),
      JSON.stringify({ id, name: `${project}-retry-1`, project }),
    ],
    [list("volume"), volumeList],
    [
      list("network"),
      JSON.stringify({ id: networkId, name: `${project}_default`, project }),
    ],
  ];
  const queries: ProcessPolicyInitialTraceQuery[] = calls.map(
    ([args, stdout], index) => ({
      token: index.toString(16).padStart(32, "0"),
      startedAt: index,
      startOrder: index * 2,
      reapOrder: index * 2 + 1,
      reapedAt: index + 1,
      args,
      stdout,
      exitCode: 0,
    })
  );
  try {
    const startup = await replayProcessPolicyInitialOwnership({
      directory: join(root, "startup"),
      queries,
      selection,
      mode: "startup",
    });
    expect(startup).toEqual({
      outcome: "unready",
      code: null,
      reason: null,
      consumed: calls.length,
      protocolMatched: true,
    });
    const strict = await replayProcessPolicyInitialOwnership({
      directory: join(root, "strict"),
      queries,
      selection,
      mode: "strict",
    });
    expect(strict).toEqual({
      outcome: "refused",
      code: "E_NATIVE_COMPOSE_OWNERSHIP",
      reason: "topology",
      consumed: 6,
      protocolMatched: true,
    });
    expect(JSON.stringify({ startup, strict })).not.toContain(owner);
    expect(JSON.stringify({ startup, strict })).not.toContain(id);
    const summary: Parameters<
      typeof persistProcessPolicyFirstAfterComposeRefusal
    >[0]["summary"] = {
      status: "captured",
      replayUsesRecordedReplies: true,
      replaysWallTiming: false,
      originalCallerModeKnown: false,
      queryCount: queries.length,
      consumedQueries: queries.length,
      complete: true,
      observations: [
        { index: 0, phase: "before-compose", startup: strict, strict },
        { index: 1, phase: "after-compose", startup, strict },
        { index: 2, phase: "after-compose", startup: strict, strict },
      ],
    };
    const capsule = await persistProcessPolicyFirstAfterComposeRefusal({
      directory: root,
      summary,
    });
    expect(capsule).toEqual({
      version: 1,
      kind: "native-process-policy-after-compose-replay-refusal",
      observationIndex: 1,
      replayUsesRecordedReplies: true,
      replaysWallTiming: false,
      originalCallerModeKnown: false,
      startupReason: null,
      strictReason: "topology",
    });
    const capsulePath = join(root, "first-after-compose-replay-refusal.json");
    const capsuleBytes = await readFile(capsulePath, "utf8");
    expect(JSON.parse(capsuleBytes)).toEqual(capsule);
    expect((await stat(capsulePath)).mode & 0o777).toBe(0o600);
    expect(capsuleBytes).not.toContain(owner);
    expect(capsuleBytes).not.toContain(id);
    expect(capsuleBytes).not.toContain(CANARY);
    await expect(
      persistProcessPolicyFirstAfterComposeRefusal({ directory: root, summary })
    ).rejects.toThrow();
    expect(await readFile(capsulePath, "utf8")).toBe(capsuleBytes);
    expect(
      await persistProcessPolicyFirstAfterComposeRefusal({
        directory: join(root, "unmatched"),
        summary: {
          ...summary,
          observations: [
            {
              index: 1,
              phase: "after-compose",
              startup,
              strict: { ...strict, protocolMatched: false },
            },
          ],
        },
      })
    ).toBeNull();
    const missing = await replayProcessPolicyInitialOwnership({
      directory: join(root, "missing"),
      queries: queries.slice(0, 1),
      selection,
      mode: "startup",
    });
    expect(missing.protocolMatched).toBe(false);
    expect(missing.outcome).toBe("refused");
    const first = queries[0];
    if (!first) {
      throw new Error("Missing synthetic query");
    }
    const changed = await replayProcessPolicyInitialOwnership({
      directory: join(root, "changed"),
      queries: [{ ...first, args: ["inspect", CANARY] }],
      selection,
      mode: "startup",
    });
    expect(changed.protocolMatched).toBe(false);
    expect(changed.outcome).toBe("refused");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
