import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitLegacyComposeCandidate } from "../src/lib/native-compose-adoption-compiler.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "adoption-compiler-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const candidateText = JSON.stringify({
  config_version: 1,
  name: "fixture",
  services: { db: { image: "postgres:17.6-alpine" } },
});
const metadata = {
  overlay: null,
  overlayExists: true,
  effectiveMetadata: { db: { PRIVATE: { scope: "global", secret: true } } },
  unknownScopes: [],
};
async function compiler(opts: {
  readonly complete?: boolean;
  readonly semanticHash?: string;
  readonly declared?: Readonly<Record<string, "service" | "job">>;
}) {
  const compiled = {
    transport_version: 1,
    ok: true,
    plan: { plan_version: 1, services: { db: {} }, jobs: {} },
    semantic_hash: "a".repeat(64),
    declared_workloads: { db: "service" },
  };
  const planned = {
    ...compiled,
    semantic_hash: opts.semanticHash ?? compiled.semantic_hash,
    declared_workloads: opts.declared ?? compiled.declared_workloads,
    local_resolution: {
      overlay: null,
      origin: "project",
      auto_branch: true,
      inherit_local: true,
      resolution_hash: "b".repeat(64),
    },
    environment_plan: {
      plan_version: 1,
      overlay: null,
      overlay_exists: true,
      complete: opts.complete ?? true,
      workloads: {
        db: {
          PRIVATE: {
            kind: "managed",
            key: "PRIVATE",
            scope: "global",
            secret: true,
          },
        },
      },
      warnings: [],
      diagnostics: [],
    },
  };
  const binary = join(root, "compiler");
  await Bun.write(
    binary,
    `#!${process.execPath}
if(process.argv[2]==="--protocol") console.log(JSON.stringify({transport_version:1,authored_version:1,plan_version:1,resolve_version:1,local_version:1,env_plan_version:1}));
else {
 const input=JSON.parse(await Bun.stdin.text());
 if(input.request_version && Object.hasOwn(input.env_metadata.workloads.db.PRIVATE,"value")) process.exit(99);
 console.log(JSON.stringify(input.request_version?${JSON.stringify(planned)}:${JSON.stringify(compiled)}));
}
`
  );
  await chmod(binary, 0o700);
  return binary;
}

test("managed candidate admission requires a complete names-only plan with the same semantic identity", async () => {
  expect(
    await admitLegacyComposeCandidate({
      candidateText,
      metadata,
      binary: await compiler({}),
    })
  ).toBe(true);
});

test.each([
  ["changed semantic identity", { semanticHash: "c".repeat(64) }],
  [
    "extra retained workload",
    { declared: { db: "service", extra: "service" } },
  ],
] as const)("managed candidate admission refuses %s", async (_name, options) => {
  expect(
    await admitLegacyComposeCandidate({
      candidateText,
      metadata,
      binary: await compiler(options),
    })
  ).toBe(false);
});

test.each([
  ["successful incomplete resolution", { complete: false }],
  ["missing retained workload", { declared: {} }],
  ["changed workload kind", { declared: { db: "job" } }],
] as const)("invalid managed compiler transport refuses %s", async (_name, options) => {
  await expect(
    admitLegacyComposeCandidate({
      candidateText,
      metadata,
      binary: await compiler(options),
    })
  ).rejects.toMatchObject({ code: "E_COMPILER_RESPONSE" });
});
