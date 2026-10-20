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
  summarizeConsumedProcessPolicyReplies,
} from "./e2e/native-process-policy-initial-replay.ts";
import {
  type ProcessPolicyInitialTraceQuery,
  prepareProcessPolicyInitialTrace,
  processPolicyInitialTraceFormats,
  processPolicyInitialTraceQuery,
  readProcessPolicyInitialTrace,
} from "./e2e/native-process-policy-initial-trace.ts";
import {
  captureNativeProcessPolicyStartupDiagnostic,
  classifyProcessPolicyMemberKeys,
} from "./e2e/native-process-policy-startup-diagnostic.ts";
import { restoreEnv } from "./helpers/env.ts";

const CANARY = "synthetic-unknown-docker-stdout-stderr-canary";
const EMPTY_MEMBER_KEYS = { hex64: 0, epPrefixed: 0, other: 0 } as const;
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

/**
 * Each forwarded command cold-starts two Bun processes (the trace forwarder and
 * the fake Docker). These bounds only stop a wedged child from hanging the run;
 * exits, bytes and trace order are still asserted exactly.
 */
const FORWARDED_DOCKER_EXEC_TIMEOUT_MS = 30_000;
/** Four forwarded commands at their exec bound, plus trace reads and rewrites. */
const INITIAL_FORWARDING_TEST_TIMEOUT_MS = 150_000;

test(
  "initial forwarding preserves bytes/exits but records no unknown output, args or stderr",
  async () => {
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
          timeoutMs: FORWARDED_DOCKER_EXEC_TIMEOUT_MS,
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
      expect((trace.queries[1]?.startOrder ?? -1) > trace.upReapOrder).toBe(
        true
      );
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
  },
  INITIAL_FORWARDING_TEST_TIMEOUT_MS
);

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
      topologyPredicate: null,
      consumed: calls.length,
      protocolMatched: true,
      memberKeyClasses: EMPTY_MEMBER_KEYS,
      restartingServices: ["retry"],
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
      topologyPredicate: "live-endpoint-membership",
      consumed: 6,
      protocolMatched: true,
      memberKeyClasses: EMPTY_MEMBER_KEYS,
      restartingServices: ["retry"],
    });
    expect(JSON.stringify({ startup, strict })).not.toContain(owner);
    expect(JSON.stringify({ startup, strict })).not.toContain(id);
    const refused = async (
      name: string,
      replace: (
        row: ProcessPolicyInitialTraceQuery
      ) => ProcessPolicyInitialTraceQuery
    ) =>
      replayProcessPolicyInitialOwnership({
        directory: join(root, name),
        queries: queries.map(replace),
        selection,
        mode: "startup",
      });
    const policy = await refused("policy", (row) =>
      JSON.stringify(row.args) === JSON.stringify(inspect("network"))
        ? { ...row, stdout: JSON.stringify({ ...network, internal: true }) }
        : row
    );
    expect(policy).toEqual({
      outcome: "refused",
      code: "E_NATIVE_COMPOSE_OWNERSHIP",
      reason: "bridge-policy",
      topologyPredicate: null,
      consumed: 6,
      protocolMatched: true,
      memberKeyClasses: EMPTY_MEMBER_KEYS,
      restartingServices: ["retry"],
    });
    const aliases = await refused("aliases", (row) =>
      JSON.stringify(row.args) === JSON.stringify(inspect("container"))
        ? {
            ...row,
            stdout: JSON.stringify({
              ...container,
              networks: {
                [`${project}_default`]: {
                  NetworkID: networkId,
                  Aliases: ["unexpected-alias"],
                },
              },
            }),
          }
        : row
    );
    expect(aliases).toEqual({
      outcome: "refused",
      code: "E_NATIVE_COMPOSE_OWNERSHIP",
      reason: "endpoint",
      topologyPredicate: null,
      consumed: 6,
      protocolMatched: true,
      memberKeyClasses: EMPTY_MEMBER_KEYS,
      restartingServices: ["retry"],
    });
    expect(JSON.stringify({ policy, aliases })).not.toContain(owner);
    expect(JSON.stringify({ policy, aliases })).not.toContain(id);
    expect(JSON.stringify({ policy, aliases })).not.toContain(import.meta.dir);
    // The refused member-key class: a Docker `ep-` placeholder endpoint and a
    // stray key beside one real container id. Only counts and fixed names leave.
    const epKey = `ep-${"9".repeat(16)}`;
    const strayKey = "private-member-canary";
    const memberKeys = await refused("member-keys", (row) =>
      JSON.stringify(row.args) === JSON.stringify(inspect("network"))
        ? {
            ...row,
            stdout: JSON.stringify({
              ...network,
              containers: { [id]: {}, [epKey]: {}, [strayKey]: {} },
            }),
          }
        : row
    );
    expect(memberKeys).toEqual({
      outcome: "refused",
      code: "E_NATIVE_COMPOSE_OWNERSHIP",
      reason: "topology",
      topologyPredicate: "network-member-id",
      consumed: 6,
      protocolMatched: true,
      memberKeyClasses: { hex64: 1, epPrefixed: 1, other: 1 },
      restartingServices: ["retry"],
    });
    const memberKeysText = JSON.stringify(memberKeys);
    expect(memberKeysText).not.toContain(epKey);
    expect(memberKeysText).not.toContain(strayKey);
    expect(memberKeysText).not.toContain(id);
    expect(memberKeysText).not.toContain(owner);
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
    // Disabled and malformed opt-ins cannot create a capsule, even for a matching refusal.
    for (const enabled of [undefined, "", "0", "true", "1\n"]) {
      expect(
        await persistProcessPolicyFirstAfterComposeRefusal({
          directory: root,
          enabled,
          summary,
        })
      ).toBeNull();
      expect(
        await Bun.file(
          join(root, "first-after-compose-replay-refusal.json")
        ).exists()
      ).toBe(false);
    }
    const capsule = await persistProcessPolicyFirstAfterComposeRefusal({
      directory: root,
      enabled: "1",
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
      startupTopologyPredicate: null,
      strictTopologyPredicate: "live-endpoint-membership",
      startupMemberKeyClasses: EMPTY_MEMBER_KEYS,
      strictMemberKeyClasses: EMPTY_MEMBER_KEYS,
      startupRestartingServices: ["retry"],
      strictRestartingServices: ["retry"],
    });
    const capsulePath = join(root, "first-after-compose-replay-refusal.json");
    const capsuleBytes = await readFile(capsulePath, "utf8");
    expect(JSON.parse(capsuleBytes)).toEqual(capsule);
    expect((await stat(capsulePath)).mode & 0o777).toBe(0o600);
    expect(capsuleBytes).not.toContain(owner);
    expect(capsuleBytes).not.toContain(id);
    expect(capsuleBytes).not.toContain(CANARY);
    await expect(
      persistProcessPolicyFirstAfterComposeRefusal({
        directory: root,
        enabled: "1",
        summary,
      })
    ).rejects.toThrow();
    expect(await readFile(capsulePath, "utf8")).toBe(capsuleBytes);
    expect(
      await persistProcessPolicyFirstAfterComposeRefusal({
        directory: join(root, "unmatched"),
        enabled: "1",
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
    expect(missing.reason).toBeNull();
    expect(missing.memberKeyClasses).toBeNull();
    expect(missing.restartingServices).toEqual([]);
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
    expect(changed.reason).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("consumed-reply summary classifies only the last consumed network and container replies", () => {
  const query = (
    args: string[],
    stdout: string,
    index: number
  ): ProcessPolicyInitialTraceQuery => ({
    token: index.toString(16).padStart(32, "0"),
    startedAt: index,
    startOrder: index * 2,
    reapOrder: index * 2 + 1,
    reapedAt: index + 1,
    args,
    stdout,
    exitCode: 0,
  });
  const epKey = `ep-${"8".repeat(16)}`;
  const queries = [
    query(list("container"), "", 0),
    query(
      inspect("container"),
      [
        JSON.stringify({ service: "retry", state: "restarting" }),
        JSON.stringify({ service: "forced", state: "running" }),
        JSON.stringify({ service: "observer", state: "restarting" }),
        "not json",
      ].join("\n"),
      1
    ),
    query(
      inspect("network"),
      JSON.stringify({ containers: { [id]: {}, [epKey]: {}, "": {} } }),
      2
    ),
    query(
      inspect("container"),
      JSON.stringify({ service: "graceful", state: "restarting" }),
      3
    ),
    query(
      inspect("network"),
      `${JSON.stringify({ containers: { [networkId]: {} } })}\n${JSON.stringify({ containers: "malformed" })}`,
      4
    ),
  ];
  expect(summarizeConsumedProcessPolicyReplies(queries, 0)).toEqual({
    memberKeyClasses: null,
    restartingServices: [],
  });
  expect(summarizeConsumedProcessPolicyReplies(queries, 1)).toEqual({
    memberKeyClasses: null,
    restartingServices: [],
  });
  // The unknown observer service and the malformed line are not fixed names.
  expect(summarizeConsumedProcessPolicyReplies(queries, 2)).toEqual({
    memberKeyClasses: null,
    restartingServices: ["retry"],
  });
  expect(summarizeConsumedProcessPolicyReplies(queries, 3)).toEqual({
    memberKeyClasses: { hex64: 1, epPrefixed: 1, other: 1 },
    restartingServices: ["retry"],
  });
  // Later replies replace earlier ones; counts never accumulate across scans.
  expect(summarizeConsumedProcessPolicyReplies(queries, 5)).toEqual({
    memberKeyClasses: { hex64: 1, epPrefixed: 0, other: 0 },
    restartingServices: ["graceful"],
  });
  expect(summarizeConsumedProcessPolicyReplies(queries, 99)).toEqual(
    summarizeConsumedProcessPolicyReplies(queries, queries.length)
  );
  const text = JSON.stringify(
    summarizeConsumedProcessPolicyReplies(queries, 3)
  );
  expect(text).not.toContain(epKey);
  expect(text).not.toContain(id);
  expect(
    classifyProcessPolicyMemberKeys([id, epKey, "ep-", 7, null, {}])
  ).toEqual({ hex64: 1, epPrefixed: 2, other: 3 });
});

test("startup diagnostic classifies refused member keys instead of hiding the capture", async () => {
  const services = ["graceful", "forced", "reaper", "retry"] as const;
  const image = `sha256:${"c".repeat(64)}`;
  const bridge = `${project}_default`;
  const engine = "fixture-engine";
  const ids = services.map((_, index) => String(index + 1).repeat(64));
  const epKey = `ep-${"7".repeat(16)}`;
  const strayKey = "private-member-canary";
  const identity = {
    checkoutRoot: "/fixture",
    repositoryRoot: "/fixture",
    instance: null,
    instanceId: "f".repeat(64),
    composeProject: project,
    ownerToken: owner,
  };
  const pending = {
    token: "e".repeat(32),
    operation: "up",
    generationId: generation,
  };
  const store = {
    identity,
    loadCurrent: async () => ({
      generation: null,
      stopped: true,
      pending,
      beforeHooksPending: false,
      hostHookPhase: null,
    }),
    loadPending: async () => ({
      identity,
      generationId: generation,
      composeFile: "/fixture/compose.yaml",
      profiles: ["exercise"],
    }),
    readGenerationDocument: async () => ({
      services: Object.fromEntries(
        services.map((name) => [name, { image, profiles: ["exercise"] }])
      ),
      networks: { default: { name: bridge } },
    }),
    close: async () => {},
  };
  const rows = services.map((service, index) => ({
    id: ids[index],
    name: `${project}-${service}-1`,
    image,
    state: service === "retry" ? "restarting" : "running",
    restartCount: service === "retry" ? 1 : 0,
    project,
    instance: project,
    owner,
    generation,
    service,
    version: "1",
    workload: "service",
    oneoff: "False",
    endpoints: [
      {
        name: bridge,
        networkId,
        aliases: [`${project}-${service}-1`, service],
      },
    ],
  }));
  const createProbe = () => async (args: readonly string[]) => {
    const key = args.slice(0, 2).join(" ");
    if (key === "info --format") {
      return engine;
    }
    if (key === "container ls") {
      return rows
        .map(({ id: rowId, name, project: rowProject }) =>
          JSON.stringify({ id: rowId, name, project: rowProject })
        )
        .join("\n");
    }
    if (key === "container inspect") {
      return rows.map((row) => JSON.stringify(row)).join("\n");
    }
    if (key === "network ls") {
      return JSON.stringify({ id: networkId, name: bridge, project });
    }
    if (key === "network inspect") {
      return JSON.stringify({
        id: networkId,
        name: bridge,
        driver: "bridge",
        internal: false,
        project,
        instance: project,
        owner,
        version: "1",
        members: [...ids, epKey, strayKey],
      });
    }
    throw new Error("unexpected diagnostic command");
  };
  const dependencies = {
    openStore: async () => store,
    createProbe,
  } as unknown as NonNullable<
    Parameters<
      typeof captureNativeProcessPolicyStartupDiagnostic
    >[0]["dependencies"]
  >;
  const report = await captureNativeProcessPolicyStartupDiagnostic({
    projectRoot: "/fixture",
    expectedEngineId: engine,
    dependencies,
  });
  for (const scan of [report.first, report.second]) {
    expect(scan.bridgeMemberKeyClasses).toEqual({
      hex64: 4,
      epPrefixed: 1,
      other: 1,
    });
    expect(scan.restartingServices).toEqual(["retry"]);
    expect(scan.bridgeMembersSelected).toBe(false);
    expect(scan.services.every((item) => item.memberMatch)).toBe(true);
  }
  expect(report.drift).toBe("none");
  const text = JSON.stringify(report);
  for (const privateValue of [
    epKey,
    strayKey,
    owner,
    generation,
    networkId,
    ...ids,
  ]) {
    expect(text).not.toContain(privateValue);
  }
});

/** The captured docker-e2e after-compose shape: three container-ID members and one `ep-` placeholder for the restarting retry service. */
test("trace replay re-observes a restarting or just-restarted endpoint placeholder member and refuses an unresolved one", async () => {
  const root = await mkdtemp(join(tmpdir(), "process-initial-placeholder-"));
  const services = ["forced", "graceful", "reaper", "retry"] as const;
  const ids = {
    forced: "1".repeat(64),
    graceful: "2".repeat(64),
    reaper: "3".repeat(64),
    retry: id,
  } as const;
  const placeholder = `ep-${"9".repeat(64)}`;
  const fleet: NativeComposeOwnershipOptions = {
    ...selection,
    expectedServices: [...services],
  };
  const container = (
    service: (typeof services)[number],
    state: "running" | "restarting"
  ) => ({
    id: ids[service],
    name: `/${project}-${service}-1`,
    project,
    version: "1",
    instance: project,
    owner,
    generation,
    service,
    oneoff: "False",
    state,
    exitCode: state === "restarting" ? 17 : 0,
    health: null,
    networks: {
      [`${project}_default`]: {
        NetworkID: networkId,
        Aliases: [`${project}-${service}-1`, service],
      },
    },
  });
  const members = (retryKey: string) =>
    Object.fromEntries(
      services.map((service) => [
        service === "retry" ? retryKey : ids[service],
        { Name: `${project}-${service}-1` },
      ])
    );
  const network = (retryKey: string) =>
    JSON.stringify({
      id: networkId,
      name: `${project}_default`,
      project,
      version: "1",
      instance: project,
      owner,
      driver: "bridge",
      internal: false,
      containers: members(retryKey),
    });
  const sorted = [...services].sort((left, right) =>
    ids[left].localeCompare(ids[right])
  );
  const containerList = sorted
    .map((service) =>
      JSON.stringify({
        id: ids[service],
        name: `${project}-${service}-1`,
        project,
      })
    )
    .join("\n");
  const containers = (retryState: "running" | "restarting") =>
    sorted
      .map((service) =>
        JSON.stringify(
          container(service, service === "retry" ? retryState : "running")
        )
      )
      .join("\n");
  const inspectContainers = [
    "container",
    "inspect",
    "--format",
    processPolicyInitialTraceFormats.container.inspect,
    ...sorted.map((service) => ids[service]),
  ];
  const volume = JSON.stringify({
    id: "process-fixture_evidence",
    name: "process-fixture_evidence",
    project,
    version: "1",
    instance: project,
    owner,
    storage: "evidence",
    createdAt: "2026-10-08T12:00:00Z",
  });
  const volumeList = JSON.stringify({
    id: "process-fixture_evidence",
    name: "process-fixture_evidence",
    project,
  });
  const networkList = JSON.stringify({
    id: networkId,
    name: `${project}_default`,
    project,
  });
  const queries = (
    first: { retryKey: string; retryState: "running" | "restarting" },
    recheck: { retryKey: string; retryState: "running" | "restarting" }
  ): ProcessPolicyInitialTraceQuery[] => {
    const calls: [string[], string][] = [
      [list("container"), containerList],
      [inspectContainers, containers(first.retryState)],
      [list("volume"), volumeList],
      [inspect("volume"), volume],
      [list("network"), networkList],
      [inspect("network"), network(first.retryKey)],
      [inspectContainers, containers(recheck.retryState)],
      [inspect("volume"), volume],
      [inspect("network"), network(recheck.retryKey)],
      [list("container"), containerList],
      [list("volume"), volumeList],
      [list("network"), networkList],
    ];
    return calls.map(([args, stdout], index) => ({
      token: index.toString(16).padStart(32, "0"),
      startedAt: index,
      startOrder: index * 2,
      reapOrder: index * 2 + 1,
      reapedAt: index + 1,
      args,
      stdout,
      exitCode: 0,
    }));
  };
  const resolved = queries(
    { retryKey: placeholder, retryState: "restarting" },
    { retryKey: ids.retry, retryState: "running" }
  );
  try {
    const startup = await replayProcessPolicyInitialOwnership({
      directory: join(root, "startup"),
      queries: resolved,
      selection: fleet,
      mode: "startup",
    });
    expect(startup).toEqual({
      outcome: "unready",
      code: null,
      reason: null,
      topologyPredicate: null,
      consumed: resolved.length,
      protocolMatched: true,
      memberKeyClasses: { hex64: 4, epPrefixed: 0, other: 0 },
      restartingServices: [],
    });
    const strict = await replayProcessPolicyInitialOwnership({
      directory: join(root, "strict"),
      queries: resolved,
      selection: fleet,
      mode: "strict",
    });
    expect(strict).toEqual({
      outcome: "refused",
      code: "E_NATIVE_COMPOSE_OWNERSHIP",
      reason: "topology",
      topologyPredicate: "network-member-id",
      consumed: 6,
      protocolMatched: true,
      memberKeyClasses: { hex64: 3, epPrefixed: 1, other: 0 },
      restartingServices: ["retry"],
    });
    const settled = queries(
      { retryKey: ids.retry, retryState: "running" },
      { retryKey: ids.retry, retryState: "running" }
    );
    const owned = await replayProcessPolicyInitialOwnership({
      directory: join(root, "owned"),
      queries: settled,
      selection: fleet,
      mode: "startup",
    });
    expect(owned).toEqual({
      outcome: "owned",
      code: null,
      reason: null,
      topologyPredicate: null,
      consumed: settled.length,
      protocolMatched: true,
      memberKeyClasses: { hex64: 4, epPrefixed: 0, other: 0 },
      restartingServices: [],
    });
    const unresolved = await replayProcessPolicyInitialOwnership({
      directory: join(root, "unresolved"),
      queries: queries(
        { retryKey: placeholder, retryState: "restarting" },
        { retryKey: placeholder, retryState: "restarting" }
      ),
      selection: fleet,
      mode: "startup",
    });
    expect(unresolved).toEqual({
      outcome: "refused",
      code: "E_NATIVE_COMPOSE_OWNERSHIP",
      reason: "topology",
      topologyPredicate: "network-member-id",
      consumed: 9,
      protocolMatched: true,
      memberKeyClasses: { hex64: 3, epPrefixed: 1, other: 0 },
      restartingServices: ["retry"],
    });
    // HACK-1271 capture (run 39279573566): the retry container was inspected `running`
    // before it exited and began its on-failure restart, so the later bridge read in the
    // same scan held only its placeholder. The recheck resolves it, so startup re-observes.
    const runningResolved = queries(
      { retryKey: placeholder, retryState: "running" },
      { retryKey: ids.retry, retryState: "running" }
    );
    const running = await replayProcessPolicyInitialOwnership({
      directory: join(root, "running"),
      queries: runningResolved,
      selection: fleet,
      mode: "startup",
    });
    expect(running).toEqual({
      outcome: "unready",
      code: null,
      reason: null,
      topologyPredicate: null,
      consumed: runningResolved.length,
      protocolMatched: true,
      memberKeyClasses: { hex64: 4, epPrefixed: 0, other: 0 },
      restartingServices: [],
    });
    const runningStrict = await replayProcessPolicyInitialOwnership({
      directory: join(root, "running-strict"),
      queries: runningResolved,
      selection: fleet,
      mode: "strict",
    });
    expect(runningStrict).toEqual({
      outcome: "refused",
      code: "E_NATIVE_COMPOSE_OWNERSHIP",
      reason: "topology",
      topologyPredicate: "network-member-id",
      consumed: 6,
      protocolMatched: true,
      memberKeyClasses: { hex64: 3, epPrefixed: 1, other: 0 },
      restartingServices: [],
    });
    const runningUnresolved = await replayProcessPolicyInitialOwnership({
      directory: join(root, "running-unresolved"),
      queries: queries(
        { retryKey: placeholder, retryState: "running" },
        { retryKey: placeholder, retryState: "running" }
      ),
      selection: fleet,
      mode: "startup",
    });
    expect(runningUnresolved).toEqual({
      outcome: "refused",
      code: "E_NATIVE_COMPOSE_OWNERSHIP",
      reason: "topology",
      topologyPredicate: "network-member-id",
      consumed: 9,
      protocolMatched: true,
      memberKeyClasses: { hex64: 3, epPrefixed: 1, other: 0 },
      restartingServices: [],
    });
    const serialized = JSON.stringify({
      startup,
      strict,
      owned,
      unresolved,
      running,
      runningStrict,
      runningUnresolved,
    });
    expect(serialized).not.toContain(owner);
    expect(serialized).not.toContain(placeholder);
    expect(serialized).not.toContain(id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
