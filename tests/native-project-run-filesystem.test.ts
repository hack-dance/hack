import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectNativeProjectRunFilesystemRecovery as inspect,
  loadNativeProjectRun as load,
  type NativeProjectRunScope,
  recoverNativeProjectRunFilesystem as recover,
  saveNativeProjectRun as save,
} from "../src/backends/native-project-run.ts";
import type { NativeRuntimeSelection } from "../src/backends/native-runtime-client.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const run = {
  run: "a".repeat(32),
  owner: "b".repeat(32),
  namespace: "c".repeat(64),
  planId: "d".repeat(64),
  effectiveEnvName: "qa",
  profiles: ["worker"],
  aws: { profile: "livenation_qa", region: "us-east-1" },
};
const runtime: NativeRuntimeSelection = {
  binary: "/unused/hack-native",
  home: "/unused/home",
};

async function fixture() {
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-mapping-reboot-"))
  );
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack");
  const nativeHome = join(projectRoot, "candidate");
  await mkdir(projectDir);
  await mkdir(nativeHome);
  const scope: NativeProjectRunScope = {
    projectRoot,
    projectDir,
    nativeHome,
    branch: "event-agent",
  };
  await save({ ...scope, run });
  const key = createHash("sha256")
    .update(JSON.stringify(scope.branch))
    .digest("hex");
  const directory = join(projectDir, ".internal/native-runs");
  const file = join(directory, `${key}.json`);
  const original = JSON.parse(await readFile(file, "utf8"));
  const oldDevice = original.scope.rootIdentity.dev + 1;
  for (const name of ["rootIdentity", "dirIdentity", "homeIdentity"]) {
    original.scope[name].dev = oldDevice;
  }
  const oldBytes = JSON.stringify(original);
  await writeFile(file, oldBytes);
  return { scope, directory, file, key, oldDevice, oldBytes, original };
}

function authority(
  pool: Awaited<ReturnType<typeof fixture>>,
  opts: {
    onCall?: (call: number) => Promise<void>;
    graph?: Record<string, unknown>;
    status?: Record<string, unknown>;
  } = {}
) {
  let call = 0;
  return async (input: {
    readonly args: readonly string[];
  }): Promise<unknown> => {
    call++;
    await opts.onCall?.(call);
    if (input.args[0] === "runtime") {
      return (
        opts.status ?? {
          phase: "running",
          process_alive: true,
          persistent_disks_identified: true,
          project_share: {
            project: pool.scope.projectRoot,
            guest_path: "/mnt/hack-projects/fixture",
            device: (await lstat(pool.scope.projectRoot)).dev,
            inode: (await lstat(pool.scope.projectRoot)).ino,
            unfiltered_source: true,
          },
        }
      );
    }
    return (
      opts.graph ?? {
        journal_incomplete: false,
        receipt: {
          run: run.run,
          owner: run.owner,
          namespace: run.namespace,
          plan_id: run.planId,
          phase: "ready-observed",
          source: {
            shared: {
              project: pool.scope.projectRoot,
              guest_path: "/mnt/hack-projects/fixture",
              device: pool.oldDevice,
              inode: (await lstat(pool.scope.projectRoot)).ino,
              unfiltered_source: true,
            },
          },
        },
      }
    );
  };
}

test("explicit mapping repair changes only three devices and retains byte-exact audit", async () => {
  const pool = await fixture();
  const invoke = authority(pool);
  await expect(load(pool.scope)).rejects.toThrow("Native project run mapping");
  const selected = await inspect({ scope: pool.scope, runtime, invoke });
  expect(selected.qualification).toContain("unproven");
  expect(await readFile(pool.file, "utf8")).toBe(pool.oldBytes);
  const repaired = await recover({
    scope: pool.scope,
    runtime,
    expectSelection: selected.selectionSha256,
    acceptLegacyDeviceRebind: true,
    invoke,
  });
  expect(repaired.repaired).toBe(true);
  expect(repaired.selectionSha256).toBe(selected.selectionSha256);
  expect(await load(pool.scope)).toEqual(run);
  const after = JSON.parse(await readFile(pool.file, "utf8"));
  expect(after.run).toEqual(pool.original.run);
  for (const name of ["rootIdentity", "dirIdentity", "homeIdentity"]) {
    expect(after.scope[name].ino).toBe(pool.original.scope[name].ino);
    expect(after.scope[name].dev).toBe(selected.newDevice);
  }
  const audit = JSON.parse(await readFile(repaired.auditPath, "utf8"));
  expect(audit.mapping).toBe(pool.oldBytes);
  expect(audit.mappingSha256).toBe(selected.mappingSha256);
  await expect(
    inspect({ scope: pool.scope, runtime, invoke })
  ).rejects.toThrow();
});

test("partial device changes, changed inode, paths, branch and malformed mapping refuse", async () => {
  for (const change of [
    "partial",
    "inode",
    "path",
    "branch",
    "schema",
    "mode",
    "link",
  ]) {
    const pool = await fixture();
    const invoke = authority(pool);
    if (change === "mode") {
      await chmod(pool.file, 0o644);
    } else if (change === "link") {
      await writeFile(`${pool.file}.link`, "foreign");
      await rm(`${pool.file}.link`);
      const { link } = await import("node:fs/promises");
      await link(pool.file, `${pool.file}.link`);
    } else {
      const value = JSON.parse(pool.oldBytes);
      if (change === "partial") {
        value.scope.dirIdentity.dev++;
      }
      if (change === "inode") {
        value.scope.homeIdentity.ino++;
      }
      if (change === "path") {
        value.scope.projectRoot = "/foreign";
      }
      if (change === "branch") {
        value.scope.branch = "foreign";
      }
      if (change === "schema") {
        value.extra = true;
      }
      await writeFile(pool.file, JSON.stringify(value));
    }
    await expect(
      inspect({ scope: pool.scope, runtime, invoke })
    ).rejects.toThrow();
  }
});

test("native graph and current share must match the exact mapped run", async () => {
  const pool = await fixture();
  for (const override of [
    { graph: { journal_incomplete: true, receipt: {} } },
    { graph: { journal_incomplete: false, receipt: { run: "f".repeat(32) } } },
    { status: { phase: "running", project_share: null } },
  ]) {
    await expect(
      inspect({ scope: pool.scope, runtime, invoke: authority(pool, override) })
    ).rejects.toThrow();
  }
});

test("stale selection, pending restart and foreign locks never change the mapping", async () => {
  const pool = await fixture();
  const invoke = authority(pool);
  const selected = await inspect({ scope: pool.scope, runtime, invoke });
  await expect(
    recover({
      scope: pool.scope,
      runtime,
      expectSelection: "f".repeat(64),
      acceptLegacyDeviceRebind: true,
      invoke,
    })
  ).rejects.toThrow();
  const lock = join(pool.directory, `${pool.key}.restart.lock.operation`);
  await mkdir(lock);
  await expect(
    inspect({ scope: pool.scope, runtime, invoke })
  ).rejects.toThrow();
  expect(await readFile(pool.file, "utf8")).toBe(pool.oldBytes);
  await rm(lock, { recursive: true });
  await writeFile(join(pool.directory, `${pool.key}.restart.json`), "{}");
  await expect(
    recover({
      scope: pool.scope,
      runtime,
      expectSelection: selected.selectionSha256,
      acceptLegacyDeviceRebind: true,
      invoke,
    })
  ).rejects.toThrow();
  expect(await readFile(pool.file, "utf8")).toBe(pool.oldBytes);
});

test("replacement mapping inode during final authority check refuses", async () => {
  const pool = await fixture();
  const invoke = authority(pool, {
    onCall: async (call) => {
      if (call === 7) {
        await rename(pool.file, `${pool.file}.preserved`);
        await writeFile(pool.file, pool.oldBytes, { mode: 0o600 });
      }
    },
  });
  const selected = await inspect({ scope: pool.scope, runtime, invoke });
  await expect(
    recover({
      scope: pool.scope,
      runtime,
      expectSelection: selected.selectionSha256,
      acceptLegacyDeviceRebind: true,
      invoke,
    })
  ).rejects.toThrow();
  expect(await readFile(pool.file, "utf8")).toBe(pool.oldBytes);
});

test("substituted lock paths are preserved and cannot authorize publication", async () => {
  for (const suffix of [".restart.lock.operation", ".lock"]) {
    const pool = await fixture();
    const lock = join(pool.directory, `${pool.key}${suffix}`);
    const invoke = authority(pool, {
      onCall: async (call) => {
        if (call === 7) {
          await rename(lock, `${lock}.preserved`);
          await mkdir(lock, { mode: 0o700 });
        }
      },
    });
    const selected = await inspect({ scope: pool.scope, runtime, invoke });
    await expect(
      recover({
        scope: pool.scope,
        runtime,
        expectSelection: selected.selectionSha256,
        acceptLegacyDeviceRebind: true,
        invoke,
      })
    ).rejects.toThrow();
    expect(await readFile(pool.file, "utf8")).toBe(pool.oldBytes);
    expect((await lstat(lock)).isDirectory()).toBe(true);
  }
});

test("an exact published audit supports retry after prepublication refusal", async () => {
  const pool = await fixture();
  const invoke = authority(pool, {
    onCall: async (call) => {
      if (call === 7) {
        await writeFile(pool.file, `${pool.oldBytes} `);
      }
    },
  });
  const selected = await inspect({ scope: pool.scope, runtime, invoke });
  await expect(
    recover({
      scope: pool.scope,
      runtime,
      expectSelection: selected.selectionSha256,
      acceptLegacyDeviceRebind: true,
      invoke,
    })
  ).rejects.toThrow();
  await writeFile(pool.file, pool.oldBytes);
  const repaired = await recover({
    scope: pool.scope,
    runtime,
    expectSelection: selected.selectionSha256,
    acceptLegacyDeviceRebind: true,
    invoke: authority(pool),
  });
  expect(repaired.repaired).toBe(true);
  expect(await load(pool.scope)).toEqual(run);
});
