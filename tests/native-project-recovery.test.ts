import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  retireNativeRecoveredPublisher,
  verifyNativeFrontendRecovery,
} from "../src/backends/native-project-recovery.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true }))
  );
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-frontend-recovery-"))
  );
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

test("recovery cleans owned lifecycle only after graph, authority and port proof", async () => {
  const f = await fixture();
  await writeFile(join(f.lifecycle, "state.json"), '{"entries":[{}]}');
  const cleanupLifecycle = async () => {
    f.events.push("lifecycle");
    await writeFile(join(f.lifecycle, "state.json"), '{"entries":[]}');
  };
  await verifyNativeFrontendRecovery({ ...f.opts, cleanupLifecycle });
  expect(f.events).toEqual([
    "processes",
    "graph",
    "authority",
    "port",
    "lifecycle",
  ]);
  const changed = structuredClone(f.receipt);
  changed.observations["container:app"].state = "present";
  f.events.length = 0;
  await expect(
    verifyNativeFrontendRecovery({
      ...f.opts,
      inspect: async () => changed,
      cleanupLifecycle,
    })
  ).rejects.toThrow("cannot prove");
  expect(f.events).not.toContain("lifecycle");
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
  await chmod(join(f.root, "native-https/owner.lock"), 0o700);
  await verifyNativeFrontendRecovery(f.opts);
  await expect(
    lstat(join(f.root, "native-https/owner.lock"))
  ).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(f.lifecycle, "state.json"), '{"entries":[{}]}');
  await expect(verifyNativeFrontendRecovery(f.opts)).rejects.toThrow(
    "cannot prove"
  );
});

test("recovery preserves an occupied or unverifiable HTTPS lock", async () => {
  const f = await fixture();
  const lock = join(f.root, "native-https/owner.lock");
  await mkdir(lock, { recursive: true, mode: 0o700 });
  await writeFile(join(lock, "owned-state"), "keep");
  await expect(verifyNativeFrontendRecovery(f.opts)).rejects.toThrow(
    "cannot prove"
  );
  await lstat(join(lock, "owned-state"));
  await rm(join(lock, "owned-state"));
  await chmod(lock, 0o755);
  await expect(verifyNativeFrontendRecovery(f.opts)).rejects.toThrow(
    "cannot prove"
  );
  await chmod(lock, 0o700);
  await expect(
    verifyNativeFrontendRecovery({ ...f.opts, httpsPort: null })
  ).rejects.toThrow("cannot prove");
  await lstat(lock);
});

test("publisher retirement requests the exact run and owner, and rejects weak acknowledgement", async () => {
  const f = await fixture();
  const args: Array<readonly string[]> = [];
  await retireNativeRecoveredPublisher({
    runtime: f.opts.runtime,
    scope: f.opts.scope,
    run: f.opts.run,
    invoke: async (input) => {
      args.push(input.args);
      return {
        run: f.opts.run.run,
        publisher_retired: true,
        data_retained: true,
      };
    },
  });
  expect(args).toEqual([
    [
      "graph",
      "retire-recovered-publisher",
      "--run-id",
      f.opts.run.run,
      "--expect-owner",
      f.opts.run.owner,
      "--json",
    ],
  ]);
  await expect(
    retireNativeRecoveredPublisher({
      runtime: f.opts.runtime,
      scope: f.opts.scope,
      run: f.opts.run,
      invoke: async () => ({ publisher_retired: true }),
    })
  ).rejects.toThrow("cannot prove");
});
