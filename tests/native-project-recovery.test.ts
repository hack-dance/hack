import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyNativeFrontendRecovery } from "../src/backends/native-project-recovery.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true }))
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hack-frontend-recovery-"));
  roots.push(root);
  const projectDir = join(root, ".hack");
  const lifecycle = join(projectDir, ".internal/lifecycle");
  await mkdir(lifecycle, { recursive: true });
  await writeFile(join(lifecycle, "state.json"), '{"entries":[]}');
  const run = {
    run: "a".repeat(32),
    owner: "b".repeat(32),
    namespace: "c".repeat(64),
    planId: "d".repeat(64),
  };
  const receipt = {
    journal_incomplete: false,
    receipt: {
      phase: "stopped-data-retained",
      run: run.run,
      owner: run.owner,
      namespace: run.namespace,
      plan_id: run.planId,
      resources: {
        app: { kind: "container", key: "app" },
        default: { kind: "network", key: "default" },
        data: { kind: "volume", key: "data" },
      },
    },
    observations: {
      "container:app": { state: "absent" },
      "network:default": { state: "absent" },
      "volume:data": { state: "present" },
    },
  };
  const events: string[] = [];
  const opts: Parameters<typeof verifyNativeFrontendRecovery>[0] = {
    runtime: { binary: "/unused", home: root },
    scope: { nativeHome: root, projectRoot: root, projectDir, branch: null },
    run,
    httpsPort: 18_443,
    legacy: true,
    inspectLegacyProcesses: async () => {
      events.push("processes");
    },
    inspect: async () => {
      events.push("graph");
      return receipt;
    },
    invoke: async () => {
      events.push("authority");
      return { authority: { present: false } };
    },
    checkPort: async () => {
      events.push("port");
    },
  };
  return { root, projectDir, lifecycle, opts, receipt, events };
}

test("recovery requires stopped owned graph, vacant HTTPS, and empty lifecycle", async () => {
  const f = await fixture();
  await verifyNativeFrontendRecovery(f.opts);
  expect(f.events).toEqual(["processes", "graph", "authority", "port"]);
});

test("changed graph, live effect, or failed legacy inventory refuses recovery", async () => {
  const f = await fixture();
  const changed = structuredClone(f.receipt);
  changed.observations["container:app"].state = "present";
  await expect(
    verifyNativeFrontendRecovery({
      ...f.opts,
      inspect: async () => changed,
    })
  ).rejects.toThrow("cannot prove");
  await expect(
    verifyNativeFrontendRecovery({
      ...f.opts,
      invoke: async () => ({ authority: { present: true } }),
    })
  ).rejects.toThrow("cannot prove");
  await expect(
    verifyNativeFrontendRecovery({
      ...f.opts,
      inspectLegacyProcesses: async () => {
        throw new Error("another frontend is live");
      },
    })
  ).rejects.toThrow("another frontend is live");
  await mkdir(join(f.root, "native-https/owner.lock"), { recursive: true });
  await expect(verifyNativeFrontendRecovery(f.opts)).rejects.toThrow(
    "cannot prove"
  );
  await rm(join(f.root, "native-https/owner.lock"), { recursive: true });
  await writeFile(join(f.lifecycle, "state.json"), '{"entries":[{}]}');
  await expect(verifyNativeFrontendRecovery(f.opts)).rejects.toThrow(
    "cannot prove"
  );
});
