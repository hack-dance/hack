import { afterEach, expect, test } from "bun:test";
import {
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
import { nativeHookPermitVersion } from "../src/backends/native-authored-hook-journal.ts";
import {
  createNativeAuthoredHostProcesses,
  retireNativeAuthoredHostProcesses,
} from "../src/backends/native-authored-host-processes.ts";
import { withNativeAuthoredProjectAdmission } from "../src/backends/native-authored-project-run.ts";
import { resolveLifecycleStatePath } from "../src/lib/lifecycle-runtime.ts";
import type { NativeEnvironmentPlan } from "../src/lib/native-env-plan-protocol.ts";
import { selectNativeHostLifecycle } from "../src/lib/native-host-lifecycle-contract.ts";
import { writeLifecycleMuxFixture } from "./helpers/lifecycle-mux-fixture.ts";

const roots = new Set<string>();
let unknown = false;
let active = false;
let restore: (() => void) | undefined;
afterEach(async () => {
  restore?.();
  restore = undefined;
  if (active || unknown) {
    return;
  }
  for (const root of roots) {
    await rm(root, { recursive: true });
  }
  roots.clear();
});
async function fixture() {
  if (active || unknown) {
    throw new Error("Previous host process case is unresolved");
  }
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-host-owner-"))
  );
  roots.add(root);
  const projectDir = join(root, ".hack");
  const bin = join(root, "bin");
  await mkdir(projectDir);
  await mkdir(bin);
  await writeLifecycleMuxFixture(bin);
  const before = {
    PATH: process.env.PATH,
    HACK_SESSIONS_MUX: process.env.HACK_SESSIONS_MUX,
    HACK_TEST_MUX_STATE: process.env.HACK_TEST_MUX_STATE,
  };
  restore = () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  process.env.PATH = `${bin}:${before.PATH ?? "/usr/bin:/bin"}`;
  process.env.HACK_SESSIONS_MUX = "tmux";
  const state = join(root, "mux.json");
  process.env.HACK_TEST_MUX_STATE = state;
  const abort = new AbortController();
  const deadline = performance.now() + 12_000;
  const remaining = () => {
    const value = Math.ceil(deadline - performance.now());
    if (value < 1 || abort.signal.aborted) {
      throw new Error("expired");
    }
    return value;
  };
  const scope = {
    projectRoot: root,
    projectDir,
    nativeHome: join(root, "native"),
    branch: null,
  };
  await mkdir(scope.nativeHome, { mode: 0o700 });
  const invocation = {
    command: {
      exec: [
        process.execPath,
        "--no-env-file",
        "-e",
        "await Bun.write('value-seen',process.env.HOST_VALUE??'missing');setInterval(()=>{},1000)",
      ],
    },
    cwd: ".",
    env_target: { kind: "host" },
    environment: { HOST_VALUE: { env_ref: "TOKEN" } },
  };
  const lifecycle = selectNativeHostLifecycle({
    host: { processes: { tunnel: invocation } },
  });
  const report: NativeEnvironmentPlan = {
    plan_version: 1,
    overlay: null,
    overlay_exists: false,
    complete: true,
    workloads: {},
    host: {
      tunnel: {
        env_target: { kind: "host" },
        bindings: {
          HOST_VALUE: {
            kind: "managed",
            key: "TOKEN",
            scope: "host",
            secret: true,
          },
        },
      },
    },
    warnings: [],
    diagnostics: [],
  };
  return {
    root,
    projectDir,
    scope,
    state,
    abort,
    remaining,
    lifecycle,
    report,
  };
}
const run = "f".repeat(32),
  semantic = "a".repeat(64),
  canary = "synthetic-private-process-value";
function ownedCase(
  name: string,
  action: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>
) {
  test(name, async () => {
    const f = await fixture();
    active = true;
    try {
      await action(f);
      active = false;
    } catch (error) {
      unknown = true;
      throw error;
    }
  }, 20_000);
}
ownedCase(
  "Source5 private process proof starts the shipping controller and exact-token stop preserves value privacy",
  async (f) => {
    await withNativeAuthoredProjectAdmission(f.scope, async (admission) => {
      const hooks = await admission.createHooks({
        run,
        selectionHash: semantic,
      });
      const owner = await createNativeAuthoredHostProcesses({
        scope: f.scope,
        run,
        semanticHash: semantic,
        projectName: "fixture",
        lifecycle: f.lifecycle,
        report: () => f.report,
        resolveValues: () => Promise.resolve({ TOKEN: canary }),
        assertFresh: admission.assertHeld,
        signal: f.abort.signal,
        remaining: f.remaining,
      });
      const permit = await hooks.permit({
        role: "preflight",
        semanticHash: semantic,
        processes: await owner.proof(false),
      });
      expect(nativeHookPermitVersion(permit)).toBe(5);
      try {
        unknown = true;
        await owner.start();
        await owner.assertReady();
        expect(await readFile(join(f.root, "value-seen"), "utf8")).toBe(canary);
        const calls = await readFile(`${f.state}.calls`, "utf8");
        expect(calls).not.toContain(canary);
        expect(calls).not.toContain("set-environment");
        const proof = await owner.proof(true);
        expect(proof.path.endsWith(".host-process-ready.json")).toBe(true);
      } finally {
        await owner.stop();
        await owner.close();
        unknown = false;
      }
      await hooks.retire();
    });
  }
);
ownedCase(
  "recovery uses the saved exact controller identity and refuses a foreign live token before any stop",
  async (f) => {
    await withNativeAuthoredProjectAdmission(f.scope, async (admission) => {
      const owner = await createNativeAuthoredHostProcesses({
        scope: f.scope,
        run,
        semanticHash: semantic,
        projectName: "fixture",
        lifecycle: f.lifecycle,
        report: () => f.report,
        resolveValues: () => Promise.resolve({ TOKEN: canary }),
        assertFresh: admission.assertHeld,
        signal: f.abort.signal,
        remaining: f.remaining,
      });
      unknown = true;
      await owner.start();
      const state = await readFile(f.state, "utf8");
      const foreign = JSON.parse(state);
      foreign.token = "foreign";
      await writeFile(f.state, JSON.stringify(foreign));
      const calls = await readFile(`${f.state}.calls`, "utf8");
      await expect(owner.stop()).rejects.toThrow("values omitted");
      const later = (await readFile(`${f.state}.calls`, "utf8")).slice(
        calls.length
      );
      expect(later).not.toContain("send-keys");
      expect(later).not.toContain("kill-session");
      await writeFile(f.state, state);
      await expect(owner.close()).rejects.toThrow("values omitted");
      await retireNativeAuthoredHostProcesses({
        scope: f.scope,
        run,
        assertFresh: admission.assertHeld,
      });
      unknown = false;
      const metadata = JSON.parse(
        await readFile(
          resolveLifecycleStatePath({ projectDir: f.projectDir }),
          "utf8"
        )
      );
      expect(metadata.entries).toEqual([]);
    });
  }
);
ownedCase(
  "byte-identical ready replacement refuses before stop and the original inode remains recoverable",
  async (f) => {
    await withNativeAuthoredProjectAdmission(f.scope, async (admission) => {
      const owner = await createNativeAuthoredHostProcesses({
        scope: f.scope,
        run,
        semanticHash: semantic,
        projectName: "fixture",
        lifecycle: f.lifecycle,
        report: () => f.report,
        resolveValues: () => Promise.resolve({ TOKEN: canary }),
        assertFresh: admission.assertHeld,
        signal: f.abort.signal,
        remaining: f.remaining,
      });
      unknown = true;
      await owner.start();
      const proof = await owner.proof(true);
      const original = `${proof.path}.preserved`;
      const bytes = await readFile(proof.path);
      await rename(proof.path, original);
      await writeFile(proof.path, bytes, { flag: "wx", mode: 0o600 });
      const calls = await readFile(`${f.state}.calls`, "utf8");
      await expect(owner.assertReady()).rejects.toThrow("values omitted");
      await expect(owner.stop()).rejects.toThrow("values omitted");
      const later = (await readFile(`${f.state}.calls`, "utf8")).slice(
        calls.length
      );
      expect(later).not.toContain("send-keys");
      expect(later).not.toContain("kill-session");
      await rm(proof.path);
      await rename(original, proof.path);
      // Rename changes ctime, so the old live owner conservatively retains its proof.
      await expect(owner.close()).rejects.toThrow("values omitted");
      await retireNativeAuthoredHostProcesses({
        scope: f.scope,
        run,
        assertFresh: admission.assertHeld,
      });
      unknown = false;
    });
  }
);
ownedCase(
  "cancellation during values refuses before mux effects and keeps the original no-replay boundary",
  async (f) => {
    await withNativeAuthoredProjectAdmission(f.scope, async (admission) => {
      const owner = await createNativeAuthoredHostProcesses({
        scope: f.scope,
        run,
        semanticHash: semantic,
        projectName: "fixture",
        lifecycle: f.lifecycle,
        report: () => f.report,
        resolveValues: () => {
          f.abort.abort();
          return Promise.resolve({ TOKEN: canary });
        },
        assertFresh: admission.assertHeld,
        signal: f.abort.signal,
        remaining: f.remaining,
      });
      await expect(owner.start()).rejects.toThrow("expired");
      await owner.stop();
      await owner.close();
      await expect(readFile(`${f.state}.calls`, "utf8")).rejects.toThrow();
    });
  }
);
