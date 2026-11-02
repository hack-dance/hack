import { afterEach, test as bunTest, expect, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import * as files from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNativeAuthoredReceipt } from "../src/backends/native-authored-graph-protocol.ts";
import { readNativeAuthoredLiveStopRecovery } from "../src/backends/native-authored-live-stop.ts";
import { captureNativeAuthoredProcessIncarnation } from "../src/backends/native-authored-process-incarnation.ts";
import {
  withNativeAuthoredProjectAdmission as admit,
  stopNativeAuthoredProject,
} from "../src/backends/native-authored-project-run.ts";
import type { NativeEnvMetadata } from "../src/lib/native-env-plan-protocol.ts";

const roots: string[] = [];
let active = 0,
  unknown = false;
function test(name: string, body: () => Promise<void>) {
  bunTest(
    name,
    async () => {
      if (unknown) {
        throw new Error("Live stop fixture lifetime unknown; roots retained.");
      }
      active++;
      try {
        await body();
      } catch (error) {
        unknown = true;
        throw error;
      } finally {
        active--;
      }
    },
    10_000
  );
}
afterEach(async () => {
  if (active !== 0) {
    unknown = true;
  }
  if (!unknown) {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  }
});
function receipt(run = "a".repeat(32)) {
  const provenance = {
    version: 1,
    kind: "native",
    namespace: "b".repeat(64),
    run,
    input: {
      semantic_hash: "c".repeat(64),
      local_resolution_hash: "d".repeat(64),
      environment_policy_hash: "e".repeat(64),
      selected_profiles: [],
    },
  };
  return {
    version: 2,
    kind: "native-graph-runtime",
    owner: "f".repeat(32),
    boot: "00000000-0000-0000-0000-000000000001",
    review: {
      provenance,
      review_id: createHash("sha256")
        .update("hack.native-graph-review/v1\0")
        .update(JSON.stringify(provenance))
        .digest("hex"),
    },
    phase: "ready-observed",
    readiness: { web: "healthy" },
    resources: {
      "network:default": {
        kind: "network",
        key: "default",
        name: `hkn-${run}-network-0`,
        id: "1".repeat(64),
        image: null,
        phase: "created",
        outbound: true,
      },
      "container:web": {
        kind: "container",
        key: "web",
        name: `hkn-${run}-container-0`,
        id: "2".repeat(64),
        image: `sha256:${"3".repeat(64)}`,
        phase: "started",
        networks: ["default"],
      },
    },
  };
}
function record(run?: string) {
  return {
    version: 2 as const,
    kind: "native-authored-project-run" as const,
    receipt: parseNativeAuthoredReceipt(receipt(run)),
  };
}
function cleaned(bound = receipt()) {
  return parseNativeAuthoredReceipt({
    ...bound,
    phase: "removed",
    resources: Object.fromEntries(
      Object.entries(bound.resources).map(([key, resource]) => [
        key,
        { ...resource, phase: "removed" },
      ])
    ),
  });
}
async function fixture() {
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-authored-artifact-"))
  );
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack");
  const nativeHome = join(projectRoot, "candidate");
  await mkdir(projectDir, { mode: 0o755 });
  await mkdir(nativeHome, { mode: 0o700 });
  return { projectRoot, projectDir, nativeHome, branch: null };
}
function metadata(): NativeEnvMetadata {
  return {
    metadata_version: 1,
    overlay: null,
    overlay_exists: true,
    workloads: { web: { TOKEN: { scope: "global", secret: true } } },
    inactive_scopes: ["off"],
  };
}

async function setup(
  opts: Awaited<ReturnType<typeof fixture>>,
  action: (value: {
    admission: Parameters<Parameters<typeof admit>[1]>[0];
    source: Awaited<
      ReturnType<Parameters<Parameters<typeof admit>[1]>[0]["prepareSource"]>
    >;
    start: Awaited<
      ReturnType<Parameters<Parameters<typeof admit>[1]>[0]["reserve"]>
    >;
    ready: Awaited<
      ReturnType<Parameters<Parameters<typeof admit>[1]>[0]["publish"]>
    >;
    path: string;
    root: string;
  }) => Promise<void>
) {
  await admit(opts, async (admission) => {
    const source = await admission.prepareSource({
      run: "a".repeat(32),
      metadata: metadata(),
    });
    const start = await admission.reserve({ review: record().receipt.review });
    const ready = await admission.publish({
      expectedStart: start,
      record: record(),
    });
    const root = join(opts.projectDir, ".internal", "native-authored-runs");
    const key = createHash("sha256")
      .update(JSON.stringify(opts.branch))
      .digest("hex");
    await action({
      admission,
      source,
      start,
      ready,
      path: join(root, `${key}.live-stop.json`),
      root,
    });
  });
}
test("no-host stop is one original operation and retires only matching Removed", async () => {
  const opts = await fixture();
  await setup(opts, async (value) => {
    let calls = 0;
    const owner = await value.admission.publishLiveStop({
      expectedStart: value.start,
      expectedRun: value.ready,
      source: value.source,
      assertFresh: async () => undefined,
      stop: async () => {
        calls++;
        await Bun.sleep(10);
        await owner.retire(cleaned());
        await value.admission.retire({
          expectedStart: value.start,
          expectedRun: value.ready,
          cleaned: cleaned(),
        });
        await value.source.remove();
        return true;
      },
    });
    try {
      expect(await value.admission.liveStopRetained()).toBe(true);
      await Promise.all([
        stopNativeAuthoredProject({ scope: opts, timeoutMs: 2000 }),
        stopNativeAuthoredProject({ scope: opts, timeoutMs: 2000 }),
      ]);
      expect(calls).toBe(1);
      expect(await value.admission.liveStopRetained()).toBe(false);
      expect(
        (await readdir(value.root)).filter((name) => name.endsWith(".json"))
      ).toEqual([]);
    } finally {
      await owner.close(true);
    }
  });
});
for (const attack of [
  "source-bytes",
  "source-inode",
  "ready",
  "record",
  "recovery",
  "dead-endpoint",
] as const) {
  test(`no-host stop retains evidence on ${attack}`, async () => {
    const opts = await fixture();
    await setup(opts, async (value) => {
      let calls = 0;
      const owner = await value.admission.publishLiveStop({
        expectedStart: value.start,
        expectedRun: value.ready,
        source: value.source,
        assertFresh: async () => undefined,
        stop: async () => {
          calls++;
          return true;
        },
      });
      try {
        if (attack === "source-bytes") {
          await writeFile(value.source.path, "{}", { mode: 0o600 });
        }
        if (attack === "source-inode") {
          const text = await Bun.file(value.source.path).text();
          await rename(value.source.path, `${value.source.path}.old`);
          await writeFile(value.source.path, text, { mode: 0o600 });
        }
        if (attack === "ready") {
          const path = value.path.replace(".live-stop.json", ".json");
          await writeFile(path, "{}", { mode: 0o600 });
        }
        if (attack === "record") {
          await writeFile(value.path, "{}", { mode: 0o600 });
        }
        if (attack === "recovery") {
          await mkdir(value.path.replace(".live-stop.json", ".recovery"), {
            mode: 0o700,
          });
        }
        if (attack === "dead-endpoint") {
          await owner.close(true);
        }
        await expect(
          stopNativeAuthoredProject({ scope: opts, timeoutMs: 200 })
        ).rejects.toThrow();
        expect(calls).toBe(0);
        expect(await value.admission.liveStopRetained()).toBe(true);
        expect(await Bun.file(value.source.path).exists()).toBe(true);
      } finally {
        await owner.close(true);
      }
    });
  });
}
test("no-host partial retirement retains start/source and cannot claim stop success", async () => {
  const opts = await fixture();
  await setup(opts, async (value) => {
    let calls = 0;
    const owner = await value.admission.publishLiveStop({
      expectedStart: value.start,
      expectedRun: value.ready,
      source: value.source,
      assertFresh: async () => undefined,
      stop: async () => {
        calls++;
        await owner.retire(cleaned());
        return true;
      },
    });
    try {
      await expect(
        stopNativeAuthoredProject({ scope: opts, timeoutMs: 1000 })
      ).rejects.toThrow();
      expect(calls).toBe(1);
      expect(await value.admission.loadStart()).not.toBeNull();
      expect(await Bun.file(value.source.path).exists()).toBe(true);
    } finally {
      await owner.close(true);
    }
  });
});
test("no-host wrong Removed binding and pre-cancellation retain all evidence", async () => {
  const opts = await fixture();
  await setup(opts, async (value) => {
    let calls = 0;
    const owner = await value.admission.publishLiveStop({
      expectedStart: value.start,
      expectedRun: value.ready,
      source: value.source,
      assertFresh: async () => undefined,
      stop: async () => {
        calls++;
        return false;
      },
    });
    try {
      await expect(
        owner.retire(cleaned(receipt("b".repeat(32))))
      ).rejects.toThrow();
      const canceled = new AbortController();
      canceled.abort();
      await expect(
        stopNativeAuthoredProject({
          scope: opts,
          timeoutMs: 1000,
          signal: canceled.signal,
        })
      ).rejects.toThrow();
      expect(calls).toBe(0);
      expect(await value.admission.liveStopRetained()).toBe(true);
    } finally {
      await owner.close(true);
    }
  });
});

for (const outcome of [
  "complete",
  "live",
  "proof-drift",
  "last-proof-rebirth",
  "forged",
] as const) {
  test(`new original settlement retains exact evidence on ${outcome}`, async () => {
    const opts = await fixture();
    await setup(opts, async (value) => {
      const child = Bun.spawn(["/bin/sleep", "30"], {
        detached: true,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      let owner:
        | Awaited<ReturnType<typeof value.admission.publishLiveStop>>
        | undefined;
      let openSpy: ReturnType<typeof spyOn<typeof files, "open">> | undefined;
      try {
        const original = await captureNativeAuthoredProcessIncarnation({
          pid: child.pid,
          selected: "/bin/sleep",
        });
        let retireArmed = false,
          proofRead = false,
          replaced = false;
        const originalOpen = files.open;
        openSpy = spyOn(files, "open").mockImplementation((...args) => {
          if (retireArmed && args[0] === `${value.path}.settled`) {
            proofRead = true;
          }
          return Reflect.apply(originalOpen, files, args);
        });
        const publication = {
          expectedStart: value.start,
          expectedRun: value.ready,
          source: value.source,
          original,
          assertFresh: async () => {
            if (
              outcome === "last-proof-rebirth" &&
              retireArmed &&
              proofRead &&
              !replaced
            ) {
              replaced = true;
              const text = await Bun.file(`${value.path}.settled`).text();
              await rename(
                `${value.path}.settled`,
                `${value.path}.original-settled`
              );
              await writeFile(`${value.path}.settled`, text, { mode: 0o600 });
            }
          },
          stop: async () => false,
        };
        if (outcome === "forged") {
          await expect(
            value.admission.publishLiveStop({
              ...publication,
              original: structuredClone(original),
            })
          ).rejects.toThrow();
          expect(await Bun.file(value.path).exists()).toBe(false);
          return;
        }
        owner = await value.admission.publishLiveStop(publication);
        if (outcome === "live") {
          await expect(owner.settled()).rejects.toThrow();
        }
        child.kill("SIGKILL");
        expect(await child.exited).toBeGreaterThan(0);
        if (outcome === "live") {
          await expect(owner.settled()).rejects.toThrow();
          expect(await Bun.file(`${value.path}.settled`).exists()).toBe(false);
          expect(await Bun.file(value.path).exists()).toBe(true);
          return;
        }
        await owner.settled();
        const record = await Bun.file(value.path).json();
        expect(record.version).toBe(2);
        expect(record.original).toEqual(original);
        const observation = await readNativeAuthoredLiveStopRecovery({
          scope: record.scope,
          path: value.path,
          ready: value.path.replace(".live-stop.json", ".json"),
          start: value.path.replace(".live-stop.json", ".start.json"),
          source: value.source.path,
          run: "a".repeat(32),
        });
        expect(observation.settled).not.toBeNull();
        await expect(owner.settled()).rejects.toThrow();
        if (outcome === "proof-drift") {
          await writeFile(`${value.path}.settled`, "{}", { mode: 0o600 });
          await expect(owner.retire(cleaned())).rejects.toThrow();
          expect(await Bun.file(value.path).exists()).toBe(true);
          expect(await Bun.file(value.source.path).exists()).toBe(true);
          return;
        }
        if (outcome === "last-proof-rebirth") {
          retireArmed = true;
          await expect(owner.retire(cleaned())).rejects.toThrow();
          expect(replaced).toBe(true);
          expect(await Bun.file(value.path).exists()).toBe(true);
          expect(await Bun.file(`${value.path}.settled`).text()).toBe(
            await Bun.file(`${value.path}.original-settled`).text()
          );
          return;
        }
        await owner.retire(cleaned());
        expect(await Bun.file(value.path).exists()).toBe(false);
        expect(await Bun.file(`${value.path}.settled`).exists()).toBe(false);
      } finally {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        await child.exited;
        await owner?.close(true);
        if (!unknown) {
          openSpy?.mockRestore();
        }
      }
    });
  });
}
