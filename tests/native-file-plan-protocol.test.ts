import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileBinding } from "../packages/config-compiler/generated/native-config.ts";
import type { NativeConfigDiagnostic } from "../src/lib/native-config-compiler.ts";
import {
  compileNativeConfig,
  planNativeConfig,
  resolveNativeConfig,
} from "../src/lib/native-config-compiler.ts";
import {
  authoredFilePlanningRequired,
  nativeFilePlanIsValid,
  nativeFileSourceMatches,
  parseNativeFilePlan,
} from "../src/lib/native-file-plan-protocol.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const declared = { reader: "service", inactive: "job" } as const;
const project = {
  schema_version: 1,
  name: "files",
  profiles: ["dev"],
  configs: { settings: { file: "./config//settings" } },
  secrets: { token: { env_ref: "TOKEN" } },
  services: {
    reader: {
      image: "reader:1",
      environment: { TOKEN: { unset: true } },
      mounts: [
        { config: "settings", target: "/etc//settings", access: "read-only" },
        { secret: "token", target: "/run/secrets/token", access: "read-only" },
      ] satisfies [Record<string, unknown>, Record<string, unknown>],
    },
  },
  jobs: {
    inactive: {
      image: "reader:1",
      profiles: ["dev"],
      mounts: [
        { config: "settings", target: "/settings", access: "read-only" },
      ],
    },
  },
};
const plan = {
  plan_version: 1,
  name: "files",
  source: { root: ".", mode: "host-mounted" },
  environment: {},
  worktree: { auto_branch: true, inherit_local: true },
  selected_profiles: [],
  storage: {},
  configs: { settings: { file: "config/settings" } },
  secrets: project.secrets,
  services: {
    reader: {
      ...project.services.reader,
      mounts: [
        {
          config: "settings",
          target: "/etc/settings",
          access: "read-only",
          mode: "0444",
        },
        {
          secret: "token",
          target: "/run/secrets/token",
          access: "read-only",
          mode: "0444",
        },
      ] satisfies [Record<string, unknown>, Record<string, unknown>],
    },
  },
  jobs: {},
};
const metadata = {
  metadata_version: 1,
  overlay: null,
  overlay_exists: false,
  workloads: {
    reader: { TOKEN: { scope: "global", secret: true } },
    inactive: {},
  },
  inactive_scopes: [],
} as const;
const filePlan = {
  plan_version: 1 as const,
  complete: true,
  workloads: {
    reader: [
      {
        kind: "config",
        name: "settings",
        source: { kind: "file", file: "config/settings" },
        target: "/etc/settings",
        access: "read-only",
        mode: "0444",
      },
      {
        kind: "secret",
        name: "token",
        source: {
          kind: "managed",
          key: "TOKEN",
          scope: "global",
          secret: true,
        },
        target: "/run/secrets/token",
        access: "read-only",
        mode: "0444",
      },
    ] satisfies [FileBinding, FileBinding],
  },
  diagnostics: [],
};
const input = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
const diagnostic = (value: unknown): NativeConfigDiagnostic => {
  if (
    !(
      typeof value === "object" &&
      value !== null &&
      "code" in value &&
      "pointer" in value
    )
  ) {
    throw new Error("Invalid fixture diagnostic");
  }
  return {
    code: String(value.code),
    pointer: String(value.pointer),
    document: "project",
    message: "A required managed environment reference is missing.",
    line: 1,
    column: 1,
  };
};

test("file roundtrip preserves root-relative sources, selected grants and permission intent", () => {
  expect(nativeFilePlanIsValid({ plan, declared })).toBe(true);
  expect(
    nativeFileSourceMatches({ input: input(project), plan, declared })
  ).toBe(true);
  expect(
    parseNativeFilePlan({
      value: filePlan,
      plan,
      metadata,
      parseDiagnostic: diagnostic,
    })
  ).toEqual(filePlan);
});

test.each([
  "configs",
  "secrets",
])("%s presence requires negotiation even when empty or inactive", (field) => {
  expect(
    authoredFilePlanningRequired(
      input({ schema_version: 1, name: "files", [field]: {} })
    )
  ).toBe(true);
  expect(authoredFilePlanningRequired(input(project))).toBe(true);
});

test("compiler file sources and grants cannot be omitted, added or changed", () => {
  for (const mutate of [
    (changed: typeof plan) => Reflect.deleteProperty(changed, "configs"),
    (changed: typeof plan) => {
      changed.configs.settings.file = "other/settings";
    },
    (changed: typeof plan) => {
      changed.services.reader.mounts[0].target = "/changed";
    },
    (changed: typeof plan) => {
      changed.services.reader.mounts[1].mode = "0400";
    },
    (changed: typeof plan) => {
      changed.services.reader.mounts.pop();
    },
  ]) {
    const changed = structuredClone(plan);
    mutate(changed);
    expect(
      nativeFileSourceMatches({
        input: input(project),
        plan: changed,
        declared,
      })
    ).toBe(false);
  }
  expect(
    nativeFileSourceMatches({
      input: input(project),
      plan,
      declared: { reader: "service" },
    })
  ).toBe(false);
  const inactiveUnknown = structuredClone(project);
  const inactiveMount = inactiveUnknown.jobs.inactive.mounts[0];
  if (!inactiveMount) {
    throw new Error("Missing inactive fixture grant");
  }
  inactiveMount.config = "missing";
  expect(
    nativeFileSourceMatches({ input: input(inactiveUnknown), plan, declared })
  ).toBe(false);
});

test("managed file authority crosschecks immutable baseline rather than the unset env map", () => {
  const result = parseNativeFilePlan({
    value: filePlan,
    plan,
    metadata,
    parseDiagnostic: diagnostic,
  });
  expect(result?.complete).toBe(true);
  const missingMetadata = {
    ...metadata,
    workloads: { reader: {}, inactive: {} },
  };
  expect(
    parseNativeFilePlan({
      value: filePlan,
      plan,
      metadata: missingMetadata,
      parseDiagnostic: diagnostic,
    })
  ).toBeNull();
  const missing = {
    ...filePlan,
    complete: false,
    workloads: { reader: [filePlan.workloads.reader[0]] },
    diagnostics: [
      {
        code: "missing_env_reference",
        pointer: "/services/reader/mounts/1/secret",
      },
    ],
  };
  expect(
    parseNativeFilePlan({
      value: missing,
      plan,
      metadata: missingMetadata,
      parseDiagnostic: diagnostic,
    })?.complete
  ).toBe(false);
});

test("file binding report cannot change grants, managed scopes or add plaintext", () => {
  for (const mutate of [
    (changed: typeof filePlan) => {
      changed.workloads.reader[1].source.scope = "reader";
    },
    (changed: typeof filePlan) => {
      changed.workloads.reader[1].target = "/changed";
    },
    (changed: typeof filePlan) => {
      changed.workloads.reader[0].source.file = "other/settings";
    },
    (changed: typeof filePlan) => {
      Object.assign(changed.workloads.reader[1].source, {
        value: "synthetic-private-marker",
      });
    },
    (changed: typeof filePlan) => {
      changed.workloads.reader.pop();
    },
  ]) {
    const changed = structuredClone(filePlan);
    mutate(changed);
    expect(
      parseNativeFilePlan({
        value: changed,
        plan,
        metadata,
        parseDiagnostic: diagnostic,
      })
    ).toBeNull();
  }
});

async function compiler(protocol: unknown, response: unknown, exitCode = 0) {
  const root = await mkdtemp(join(tmpdir(), "hack-file-protocol-"));
  roots.push(root);
  const receipt = join(root, "received");
  const binary = join(root, "compiler");
  await Bun.write(
    binary,
    `#!${process.execPath}\nif (process.argv[2] === '--protocol') { console.log(${JSON.stringify(JSON.stringify(protocol))}); } else { await Bun.write(${JSON.stringify(receipt)}, await Bun.stdin.text()); console.log(${JSON.stringify(JSON.stringify(response))}); process.exitCode = ${exitCode}; }\n`
  );
  await chmod(binary, 0o755);
  return { binary, receipt };
}

const protocol = {
  transport_version: 1,
  authored_version: 1,
  plan_version: 1,
  resolve_version: 1,
  local_version: 1,
  env_plan_version: 1,
  file_plan_version: 1,
};
const success = {
  transport_version: 1,
  ok: true,
  plan,
  declared_workloads: declared,
  semantic_hash: "a".repeat(64),
};

test("old compiler refuses every file presence before authored input delivery", async () => {
  const { file_plan_version: omitted, ...oldProtocol } = protocol;
  void omitted;
  for (const authored of [
    project,
    { schema_version: 1, name: "files", configs: {} },
    { schema_version: 1, name: "files", secrets: {} },
  ]) {
    for (const operation of ["compile", "resolve", "plan"]) {
      const { binary, receipt } = await compiler(oldProtocol, success);
      const options = { input: input(authored), binary };
      const result =
        operation === "compile"
          ? compileNativeConfig(options)
          : operation === "resolve"
            ? resolveNativeConfig(options)
            : planNativeConfig({ ...options, envMetadata: metadata });
      await expect(result).rejects.toThrow("version mismatch");
      expect(await Bun.file(receipt).exists()).toBe(false);
    }
  }
});

test("advertised file capability still refuses a compiler that drops original file intent", async () => {
  const { configs: omitted, ...dropped } = plan;
  void omitted;
  const { binary } = await compiler(protocol, { ...success, plan: dropped });
  await expect(
    compileNativeConfig({ input: input(project), binary })
  ).rejects.toThrow("invalid file declarations");
});

test("file source bytes are captured before asynchronous compiler negotiation", async () => {
  const { binary, receipt } = await compiler(protocol, success);
  const original = input(project);
  const options = { input: original, binary };
  const running = compileNativeConfig(options);
  original.fill(32);
  options.input = input({ schema_version: 1, name: "changed", configs: {} });
  expect((await running).ok).toBe(true);
  expect(JSON.parse(await Bun.file(receipt).text())).toEqual(project);
});

test("file planning reconciles separate complete and incomplete file reports", async () => {
  const local = {
    overlay: null,
    origin: "project",
    auto_branch: true,
    inherit_local: true,
    resolution_hash: "b".repeat(64),
  };
  const response = {
    ...success,
    local_resolution: local,
    environment_plan: {
      plan_version: 1,
      overlay: null,
      overlay_exists: false,
      complete: true,
      workloads: { reader: {} },
      warnings: [],
      diagnostics: [],
    },
    file_plan: filePlan,
  };
  const { binary } = await compiler(protocol, response);
  const result = await planNativeConfig({
    input: input(project),
    binary,
    envMetadata: metadata,
  });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("Expected file planning success");
  }
  expect(result.file_plan?.complete).toBe(true);
  expect(result.environment_plan.workloads.reader).toEqual({});
  const missingMetadata = {
    ...metadata,
    workloads: { reader: {}, inactive: {} },
  };
  const incomplete = {
    ...response,
    file_plan: {
      ...filePlan,
      complete: false,
      workloads: { reader: [filePlan.workloads.reader[0]] },
      diagnostics: [
        diagnostic({
          code: "missing_env_reference",
          pointer: "/services/reader/mounts/1/secret",
        }),
      ],
    },
  };
  const missing = await compiler(protocol, incomplete, 1);
  const unresolved = await planNativeConfig({
    input: input(project),
    binary: missing.binary,
    envMetadata: missingMetadata,
  });
  expect(unresolved.ok).toBe(true);
  if (!unresolved.ok) {
    throw new Error("Expected incomplete file planning report");
  }
  expect(unresolved.environment_plan.complete).toBe(true);
  expect(unresolved.file_plan?.complete).toBe(false);
});
