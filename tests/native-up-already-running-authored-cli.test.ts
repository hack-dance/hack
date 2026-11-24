import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseNativeAuthoredReceipt } from "../src/backends/native-authored-graph-protocol.ts";
import {
  nativeAuthoredProjectNamespace,
  saveNativeAuthoredProjectRun,
} from "../src/backends/native-authored-project-run.ts";
import { nativeSetupScriptReply } from "./helpers/native-setup-inspection.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-2620 through the source CLI: a second `hack up -d` on a running
 * authored project exits 0 and says it is already running, as a Compose-file
 * project does. The stub runtime answers only setup inspection and the one
 * read-only authored observation; any other call (a detached start) is logged
 * and fails. Nothing here starts a VM or a real runtime.
 */

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-up-authored-cli-"))
  );
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack");
  const nativeHome = join(projectRoot, "candidate");
  await mkdir(projectDir, { mode: 0o700 });
  await mkdir(nativeHome, { mode: 0o700 });
  await Bun.write(
    join(projectDir, "hack.project.json"),
    JSON.stringify({ name: "authored-running" })
  );
  const scope = { projectRoot, projectDir, nativeHome, branch: null };
  const provenance = {
    version: 1,
    kind: "native",
    namespace: nativeAuthoredProjectNamespace(scope),
    run: "a".repeat(32),
    input: {
      semantic_hash: "b".repeat(64),
      local_resolution_hash: "c".repeat(64),
      environment_policy_hash: "d".repeat(64),
      selected_profiles: [],
    },
  };
  const review = {
    provenance,
    review_id: createHash("sha256")
      .update("hack.native-graph-review/v1\0")
      .update(JSON.stringify(provenance))
      .digest("hex"),
  };
  const receipt = parseNativeAuthoredReceipt({
    version: 2,
    kind: "native-graph-runtime",
    owner: "e".repeat(32),
    boot: "00000000-0000-0000-0000-000000000001",
    review,
    phase: "ready-observed",
    readiness: { web: "healthy" },
    resources: {
      "network:default": {
        kind: "network",
        key: "default",
        name: `hkn-${provenance.run}-network-0`,
        id: "1".repeat(64),
        image: null,
        phase: "created",
        outbound: true,
      },
      "container:web": {
        kind: "container",
        key: "web",
        name: `hkn-${provenance.run}-container-0`,
        id: "2".repeat(64),
        image: `sha256:${"3".repeat(64)}`,
        phase: "started",
        networks: ["default"],
      },
    },
  });
  await saveNativeAuthoredProjectRun({
    ...scope,
    record: { version: 2, kind: "native-authored-project-run", receipt },
  });
  const reply = {
    version: 2,
    kind: "native-graph-control-reply",
    run: provenance.run,
    review: review.review_id,
    result: {
      outcome: "observed",
      snapshot: {
        receipt,
        observations: { web: { state: "running", health: "healthy" } },
      },
    },
  };
  const binary = join(nativeHome, "native");
  const calls = join(projectRoot, "calls");
  const observe = JSON.stringify([
    "--candidate-root",
    nativeHome,
    "graph",
    "native",
    "control",
    "--run-id",
    provenance.run,
    "--action",
    "observe",
    "--json",
  ]);
  await Bun.write(
    binary,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
${nativeSetupScriptReply()}
const args = process.argv.slice(2);
if (args[0]?.startsWith("--internal-timings=")) args.shift();
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (JSON.stringify(args) === ${JSON.stringify(observe)}) {
  console.log(${JSON.stringify(JSON.stringify(reply))});
  process.exit(0);
}
process.stderr.write(JSON.stringify({ code: "runtime_not_running" }));
process.exit(1);
`
  );
  await chmod(binary, 0o700);
  const env = privateCliEnv({
    root: projectRoot,
    env: {
      HACK_RUNTIME_BACKEND: "native",
      HACK_NATIVE_BINARY: binary,
      HACK_NATIVE_HOME: nativeHome,
      HACK_CONFIG_COMPILER_BINARY: "/must-not-compile",
      HACK_NO_INTERACTIVE: "1",
      HACK_LOGGER: "console",
      XDG_CONFIG_HOME: join(projectRoot, "xdg-config"),
      XDG_STATE_HOME: join(projectRoot, "xdg-state"),
      XDG_CACHE_HOME: join(projectRoot, "xdg-cache"),
      XDG_DATA_HOME: join(projectRoot, "xdg-data"),
    },
  });
  return { projectRoot, env, calls, observe };
}

async function up(f: Awaited<ReturnType<typeof fixture>>, json: boolean) {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../index.ts"),
      "up",
      "-d",
      ...(json ? ["--json"] : []),
      "--path",
      f.projectRoot,
    ],
    { cwd: f.projectRoot, env: f.env, stdout: "pipe", stderr: "pipe" }
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

test.each([
  true,
  false,
])("a second up -d on a running authored project exits 0 as already running (json=%s)", async (json) => {
  const f = await fixture();
  const result = await up(f, json);
  expect({ exitCode: result.exitCode, stderr: result.stderr }).toMatchObject({
    exitCode: 0,
  });
  if (json) {
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: {
        action: "up",
        alreadyRunning: true,
        project: "authored-running",
        branch: null,
        composeProject: "authored-running",
        services: { started: ["web"], completed: [], warming: [] },
        readiness: "ready",
      },
    });
  } else {
    expect(result.stdout).toContain("Project is already running.");
  }
  expect(result.stderr).not.toContain("E_STARTUP_INCOMPLETE");
  // Only setup inspection and the one read-only observation reached the runtime.
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n");
  expect(calls).toEqual([f.observe]);
}, 90_000);
