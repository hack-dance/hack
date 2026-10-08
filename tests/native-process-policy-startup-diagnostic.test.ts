import { expect, test } from "bun:test";
import { expectExit } from "./e2e/harness.ts";
import {
  captureNativeProcessPolicyStartupDiagnostic,
  isKnownUncertainProcessPolicyStartup,
  recordKnownUncertainProcessPolicyStartup,
} from "./e2e/native-process-policy-startup-diagnostic.ts";

const services = ["graceful", "forced", "reaper", "retry"] as const;
const project = "fixture";
const owner = "a".repeat(32);
const generationId = "b".repeat(32);
const image = `sha256:${"c".repeat(64)}`;
const bridgeId = "d".repeat(64);
const bridge = `${project}_default`;
const engine = "fixture-engine";
const ids = services.map((_, index) => String(index + 1).repeat(64));
const uncertain = {
  exitCode: 1,
  timedOut: false,
  stdout: JSON.stringify({
    ok: false,
    error: {
      code: "E_CONFIG_INVALID",
      message:
        "Native Compose operation has an uncertain outcome; inspect the saved generation or explicitly stop its owned resources before retrying.",
    },
  }),
};

function fixture(
  opts: {
    readonly mutate?: (scan: number, rows: Record<string, unknown>[]) => void;
    readonly pendingOperation?: string;
    readonly changedReceipt?: boolean;
    readonly failProbe?: boolean;
    readonly networkProject?: string;
  } = {}
) {
  const pending = {
    token: "e".repeat(32),
    operation: opts.pendingOperation ?? "up",
    generationId,
  };
  const identity = {
    checkoutRoot: "/fixture",
    repositoryRoot: "/fixture",
    instance: null,
    instanceId: "f".repeat(64),
    composeProject: project,
    ownerToken: owner,
  };
  const generation = {
    identity,
    generationId,
    composeFile: "/fixture/compose.yaml",
    profiles: ["exercise"],
  };
  const document = {
    services: {
      ...Object.fromEntries(
        services.map((name) => [name, { image, profiles: ["exercise"] }])
      ),
      observer: { image, profiles: ["readback"] },
    },
    networks: { default: { name: bridge } },
  };
  let stateReads = 0;
  let scans = 0;
  const commands: string[][] = [];
  const store = {
    identity,
    loadCurrent: async () => {
      stateReads += 1;
      return {
        generation: null,
        stopped: true,
        pending:
          stateReads > 1 && opts.changedReceipt
            ? { ...pending, token: "0".repeat(32) }
            : pending,
        beforeHooksPending: false,
        hostHookPhase: null,
      };
    },
    loadPending: async () => generation,
    readGenerationDocument: async () => document,
    close: async () => {},
  };
  const createProbe = () => {
    scans += 1;
    const selectedScan = scans;
    return async (args: readonly string[]) => {
      commands.push([...args]);
      if (opts.failProbe) {
        throw new Error("secret probe output");
      }
      const key = args.slice(0, 2).join(" ");
      if (key === "info --format") {
        return engine;
      }
      const rows = services.map((service, index) => ({
        id: ids[index],
        name: `${project}-${service}-1`,
        image,
        state: "running",
        restartCount: service === "retry" ? 2 : 0,
        project,
        instance: project,
        owner,
        generation: generationId,
        service,
        version: "1",
        workload: "service",
        oneoff: "False",
        endpoints: [
          {
            name: bridge,
            networkId: bridgeId,
            aliases: [`${project}-${service}-1`, service],
          },
        ],
      }));
      opts.mutate?.(selectedScan, rows);
      if (key === "container ls") {
        return rows
          .map(({ id, name, project: selectedProject }) =>
            JSON.stringify({ id, name, project: selectedProject })
          )
          .join("\n");
      }
      if (key === "container inspect") {
        return rows.map((row) => JSON.stringify(row)).join("\n");
      }
      if (key === "network ls") {
        return JSON.stringify({
          id: bridgeId,
          name: bridge,
          project: opts.networkProject ?? project,
        });
      }
      if (key === "network inspect") {
        return JSON.stringify({
          id: bridgeId,
          name: bridge,
          driver: "bridge",
          internal: false,
          project,
          instance: project,
          owner,
          version: "1",
          members: ids,
        });
      }
      throw new Error("unexpected diagnostic command");
    };
  };
  return {
    commands,
    dependencies: {
      openStore: async () => store,
      createProbe,
    } as unknown as NonNullable<
      Parameters<
        typeof captureNativeProcessPolicyStartupDiagnostic
      >[0]["dependencies"]
    >,
  };
}

test("only exact uncertain startup opts into read-only diagnostic", async () => {
  expect(isKnownUncertainProcessPolicyStartup(uncertain)).toBe(true);
  for (const result of [
    { ...uncertain, exitCode: 0 },
    { ...uncertain, timedOut: true },
    { ...uncertain, stdout: "secret malformed" },
    {
      ...uncertain,
      stdout: JSON.stringify({
        ok: false,
        error: { code: "E_CONFIG_INVALID", message: "other" },
      }),
    },
  ]) {
    expect(isKnownUncertainProcessPolicyStartup(result)).toBe(false);
  }
  let effects = 0;
  expect(
    await recordKnownUncertainProcessPolicyStartup({
      result: { ...uncertain, exitCode: 0 },
      projectRoot: "/fixture",
      expectedEngineId: engine,
      capture: async () => {
        effects += 1;
        throw new Error("must not run");
      },
      record: async () => {
        effects += 1;
      },
    })
  ).toEqual({ status: "not-applicable" });
  expect(effects).toBe(0);
});

test("exact pending selection produces fixed fields with read-only bounded commands", async () => {
  const selected = fixture();
  const report = await captureNativeProcessPolicyStartupDiagnostic({
    projectRoot: "/fixture",
    expectedEngineId: engine,
    dependencies: selected.dependencies,
  });
  expect(report.version).toBe(1);
  expect(report.drift).toBe("none");
  expect(report.first.inventoryMatch).toBe(true);
  expect(report.first.bridgePolicyMatch).toBe(true);
  expect(report.first.services.map((item) => item.service)).toEqual([
    ...services,
  ]);
  expect(
    report.first.services.every(
      (item) =>
        item.ownerMatch &&
        item.imageMatch &&
        item.endpointKeyMatch &&
        item.networkIdMatch &&
        item.aliasesMatch &&
        item.memberMatch
    )
  ).toBe(true);
  const text = JSON.stringify(report);
  for (const privateValue of [
    owner,
    generationId,
    image,
    bridgeId,
    ...ids,
    project,
  ]) {
    expect(text).not.toContain(privateValue);
  }
  expect(selected.commands).toHaveLength(12);
  expect(
    selected.commands.every(
      (args) =>
        ["info", "container", "network"].includes(args[0] ?? "") &&
        !args.some((arg) => ["rm", "start", "stop", "create"].includes(arg))
    )
  ).toBe(true);
});

test("state drift is reported while stale receipts and foreign names refuse", async () => {
  const changed = fixture({
    mutate: (scan, rows) => {
      if (scan === 2) {
        rows[0]!.state = "restarting";
      }
    },
  });
  const report = await captureNativeProcessPolicyStartupDiagnostic({
    projectRoot: "/fixture",
    expectedEngineId: engine,
    dependencies: changed.dependencies,
  });
  expect(report.drift).toBe("state");
  for (const selected of [
    fixture({ pendingOperation: "down" }),
    fixture({ changedReceipt: true }),
    fixture({ networkProject: "foreign" }),
    fixture({
      mutate: (_scan, rows) => {
        rows[0]!.project = "foreign";
      },
    }),
    fixture({
      mutate: (_scan, rows) => {
        rows[0]!.endpoints = "malformed";
      },
    }),
  ]) {
    await expect(
      captureNativeProcessPolicyStartupDiagnostic({
        projectRoot: "/fixture",
        expectedEngineId: engine,
        dependencies: selected.dependencies,
      })
    ).rejects.toThrow();
  }
});

test("malicious observation text is reduced to fixed booleans and unknown state", async () => {
  const canary = "private-observation-canary";
  const selected = fixture({
    mutate: (_scan, rows) => {
      const first = rows[0];
      if (first) {
        first.state = canary;
        first.owner = canary;
        first.endpoints = [
          { name: bridge, networkId: bridgeId, aliases: [canary] },
        ];
      }
    },
  });
  const report = await captureNativeProcessPolicyStartupDiagnostic({
    projectRoot: "/fixture",
    expectedEngineId: engine,
    dependencies: selected.dependencies,
  });
  expect(report.first.services[0]?.state).toBe("unknown");
  expect(report.first.services[0]?.ownerMatch).toBe(false);
  expect(report.first.services[0]?.aliasesMatch).toBe(false);
  expect(JSON.stringify(report)).not.toContain(canary);
});

test("malformed state shapes and negative restart counts cannot escape fixed output", async () => {
  for (const state of [["running"], { value: "running" }, 7, null]) {
    const selected = fixture({
      mutate: (_scan, rows) => {
        const first = rows[0];
        if (first) {
          first.state = state;
          first.restartCount = -1;
        }
      },
    });
    const report = await captureNativeProcessPolicyStartupDiagnostic({
      projectRoot: "/fixture",
      expectedEngineId: engine,
      dependencies: selected.dependencies,
    });
    expect(report.first.services[0]?.state).toBe("unknown");
    expect(typeof report.first.services[0]?.state).toBe("string");
    expect(report.first.services[0]?.restartCount).toBeNull();
    expect(report.second.services[0]?.restartCount).toBeNull();
  }
});

test("diagnostic and recording errors cannot replace original failed startup", async () => {
  const selected = fixture({ failProbe: true });
  let recorded = 0;
  const status = await recordKnownUncertainProcessPolicyStartup({
    result: uncertain,
    projectRoot: "/fixture",
    expectedEngineId: engine,
    capture: (opts) =>
      captureNativeProcessPolicyStartupDiagnostic({
        ...opts,
        dependencies: selected.dependencies,
      }),
    record: async () => {
      recorded += 1;
    },
  });
  expect(status).toEqual({
    status: "unavailable",
    stage: "first-scan",
    reason: "external_store_or_probe",
  });
  expect(recorded).toBe(0);
  expect(uncertain.exitCode).toBe(1);
  expect(JSON.stringify(status)).not.toContain("secret");
  const success = fixture();
  expect(
    await recordKnownUncertainProcessPolicyStartup({
      result: uncertain,
      projectRoot: "/fixture",
      expectedEngineId: engine,
      capture: (opts) =>
        captureNativeProcessPolicyStartupDiagnostic({
          ...opts,
          dependencies: success.dependencies,
        }),
      record: async () => {
        throw new Error("secret file failure");
      },
    })
  ).toEqual({
    status: "unavailable",
    stage: "record",
    reason: "external_store_or_probe",
  });
});

test("own failed predicate is allowlisted while original startup still fails", async () => {
  const selected = fixture({ pendingOperation: "down" });
  const outcome = await recordKnownUncertainProcessPolicyStartup({
    result: uncertain,
    projectRoot: "/fixture",
    expectedEngineId: engine,
    capture: (opts) =>
      captureNativeProcessPolicyStartupDiagnostic({
        ...opts,
        dependencies: selected.dependencies,
      }),
    record: async () => {
      throw new Error("must not record");
    },
  });
  expect(outcome).toEqual({
    status: "unavailable",
    stage: "saved-selection",
    reason: "diagnostic_pending_selection",
  });
  expect(uncertain.exitCode).toBe(1);
  expect(selected.commands).toHaveLength(0);
  expect(() =>
    expectExit({
      result: {
        ...uncertain,
        command: "hack --profile exercise up --detach --json",
        stderr: "",
        combined: uncertain.stdout,
        durationMs: 1,
      },
      codes: [0],
      message: "Native --profile must succeed",
    })
  ).toThrow("expected exit 0, got 1");
});
