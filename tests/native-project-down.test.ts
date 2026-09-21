import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeProjectDown } from "../src/backends/native-project-down.ts";
import {
  loadNativeProjectRun,
  removeNativeProjectRun,
  saveNativeProjectRun,
} from "../src/backends/native-project-run.ts";

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
};
const id = "e".repeat(64);
function snapshot() {
  return {
    receipt: {
      ...run,
      plan_id: run.planId,
      phase: "ready-observed",
      resources: {
        "container:web": {
          kind: "container",
          key: "web",
          id,
          phase: "started",
        },
      },
    },
    journal_incomplete: false,
    observations: { "container:web": { state: "running", health: "healthy" } },
  };
}
async function fixture(saved = true) {
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-observe-"))
  );
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack"),
    nativeHome = join(projectRoot, "candidate");
  await mkdir(projectDir);
  await mkdir(nativeHome);
  const scope = { projectRoot, projectDir, nativeHome, branch: null };
  if (saved) {
    await saveNativeProjectRun({ ...scope, run });
  }
  return { scope, runtime: { binary: "/not-invoked", home: nativeHome } };
}

test("down invokes cleanup once then validates absence before mapping retirement and after hook", async () => {
  const opts = await fixture();
  const events: string[] = [];
  let cleaned = false;
  const result = await nativeProjectDown({
    ...opts,
    before: async () => {
      events.push("before");
    },
    after: async () => {
      expect(await loadNativeProjectRun(opts.scope)).toBeNull();
      events.push("after");
    },
    invoke: async (request) => {
      events.push(request.args[1]!);
      if (request.args[1] === "cleanup") {
        cleaned = true;
        expect(request.args).not.toContain("--remove-data");
        return {};
      }
      const value = snapshot();
      if (cleaned) {
        value.receipt.phase = "stopped-data-retained";
        value.observations["container:web"].state = "absent";
      }
      return value;
    },
  });
  expect(result.status).toBe("stopped");
  expect(events).toEqual([
    "inspect",
    "before",
    "inspect",
    "cleanup",
    "inspect",
    "after",
  ]);
});
test("unconfirmed cleanup retains mapping and skips after hook", async () => {
  const opts = await fixture();
  let effects = 0;
  await expect(
    nativeProjectDown({
      ...opts,
      after: async () => {
        throw new Error("unexpected after");
      },
      invoke: async (request) => {
        if (request.args[1] === "cleanup") {
          effects++;
          return {};
        }
        return snapshot();
      },
    })
  ).rejects.toThrow("unconfirmed");
  expect(effects).toBe(1);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});
test("foreground concurrent mapping removal is accepted only after confirmed cleanup", async () => {
  const opts = await fixture();
  let cleaned = false;
  await nativeProjectDown({
    ...opts,
    invoke: async (request) => {
      if (request.args[1] === "cleanup") {
        cleaned = true;
        await removeNativeProjectRun({ ...opts.scope, expected: run });
        return {};
      }
      const value = snapshot();
      if (cleaned) {
        value.receipt.phase = "stopped-data-retained";
        value.observations["container:web"].state = "absent";
      }
      return value;
    },
  });
  expect(await loadNativeProjectRun(opts.scope)).toBeNull();
});
test("foreign owner refuses before hooks or cleanup", async () => {
  const opts = await fixture();
  let calls = 0;
  await expect(
    nativeProjectDown({
      ...opts,
      before: async () => {
        throw new Error("unexpected hook");
      },
      invoke: async () => {
        calls++;
        const value = snapshot();
        value.receipt.owner = "f".repeat(32);
        return value;
      },
    })
  ).rejects.toThrow("unconfirmed");
  expect(calls).toBe(1);
  expect(await loadNativeProjectRun(opts.scope)).toEqual(run);
});

test("native down rejects unsupported flags before project or runtime access", async () => {
  for (const args of [
    ["--env", "qa"],
    ["--profile", "web"],
    ["--prune-caches"],
    ["--yes"],
    ["--target", "remote"],
  ]) {
    const child = Bun.spawn([process.execPath, "index.ts", "down", ...args], {
      env: {
        ...process.env,
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_HOME: "/nonexistent-native-home",
        HACK_NATIVE_BINARY: "/nonexistent-native-binary",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).not.toBe(0);
      expect(stdout + stderr).toContain("Native down preserves data");
    } finally {
      clearTimeout(timer);
    }
  }
});

test("configured down hooks refuse before invoking native or lifecycle commands", async () => {
  const opts = await fixture(false);
  await writeFile(
    join(opts.scope.projectDir, "hack.config.json"),
    JSON.stringify({
      name: "native-test",
      lifecycle: { down: { before: ["exit 87"] } },
    })
  );
  await writeFile(
    join(opts.scope.projectDir, "docker-compose.yml"),
    "services:\n  web:\n    image: fixture\n"
  );
  const child = Bun.spawn(
    [process.execPath, "index.ts", "down", "--path", opts.scope.projectRoot],
    {
      env: {
        ...process.env,
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_HOME: opts.scope.nativeHome,
        HACK_NATIVE_BINARY: "/nonexistent-native-binary",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).not.toBe(0);
    expect(stdout + stderr).toContain(
      "Native down lifecycle hooks require persisted startup environment selection"
    );
  } finally {
    clearTimeout(timer);
  }
});
