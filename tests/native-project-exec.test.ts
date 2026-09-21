import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeProjectExec } from "../src/backends/native-project-exec.ts";
import { saveNativeProjectRun } from "../src/backends/native-project-run.ts";

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

test("native exec preserves literal argv, binary output and nonzero completion", async () => {
  const opts = await fixture();
  const argv = ["printf", "a b", "$(literal)"];
  let count = 0;
  const result = await nativeProjectExec({
    ...opts,
    service: "web",
    argv,
    workdir: "/app",
    invoke: async (request) => {
      count++;
      if (request.args[1] === "inspect") {
        return snapshot();
      }
      expect(request.args.slice(-4)).toEqual(["--", ...argv]);
      expect(request.args).toContain("/app");
      return {
        exit_code: 23,
        stdout_base64: Buffer.from([0, 255, 10]).toString("base64"),
        stderr_base64: "ZXJy",
        truncated: true,
      };
    },
  });
  expect(count).toBe(3);
  expect(result).toEqual({
    exitCode: 23,
    stdout: Buffer.from([0, 255, 10]),
    stderr: Buffer.from("err"),
    truncated: true,
  });
});
test("invalid arguments and absent mapping never execute", async () => {
  const opts = await fixture(false);
  const invoke = async () => {
    throw new Error("unexpected runtime");
  };
  await expect(
    nativeProjectExec({ ...opts, service: "web", argv: ["true"], invoke })
  ).rejects.toThrow("not been started");
  for (const argv of [[], [""], ["echo", "\0"]]) {
    await expect(
      nativeProjectExec({ ...opts, service: "web", argv, invoke })
    ).rejects.toThrow("requires");
  }
});
test("foreign receipt refuses before exec and changed container after exec is uncertain without replay", async () => {
  const opts = await fixture();
  let executions = 0;
  const invoke = async (request: { args: readonly string[] }) => {
    if (request.args[1] === "exec") {
      executions++;
      return {
        exit_code: 0,
        stdout_base64: "",
        stderr_base64: "",
        truncated: false,
      };
    }
    const value = snapshot();
    value.receipt.owner = "f".repeat(32);
    return value;
  };
  await expect(
    nativeProjectExec({ ...opts, service: "web", argv: ["true"], invoke })
  ).rejects.toThrow("mapping");
  expect(executions).toBe(0);
  await expect(
    nativeProjectExec({
      ...opts,
      service: "web",
      argv: ["true"],
      invoke: async (request) => {
        if (request.args[1] === "exec") {
          executions++;
          return {
            exit_code: 0,
            stdout_base64: "",
            stderr_base64: "",
            truncated: false,
          };
        }
        const value = snapshot();
        if (executions) {
          value.receipt.resources["container:web"].id = "f".repeat(64);
        }
        return value;
      },
    })
  ).rejects.toThrow("unconfirmed");
  expect(executions).toBe(1);
});

test("native exec rejects env and profile before project lookup or runtime effects", async () => {
  for (const flag of ["--env", "--profile"]) {
    const child = Bun.spawn(
      [process.execPath, "index.ts", "exec", flag, "qa", "web", "true"],
      {
        env: {
          ...process.env,
          HACK_RUNTIME_BACKEND: "native",
          HACK_NATIVE_HOME: "/nonexistent-native-home",
          HACK_NATIVE_BINARY: "/nonexistent-native-binary",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).not.toBe(0);
    expect(stdout + stderr).toContain(
      "Native exec does not support --env or --profile"
    );
  }
});

test("malformed exec output refuses without replay", async () => {
  const opts = await fixture();
  for (const bad of ["not base64!", "Zh=="]) {
    let executions = 0;
    await expect(
      nativeProjectExec({
        ...opts,
        service: "web",
        argv: ["true"],
        invoke: async (request) => {
          if (request.args[1] === "inspect") {
            return snapshot();
          }
          executions++;
          return {
            exit_code: 0,
            stdout_base64: bad,
            stderr_base64: "",
            truncated: false,
          };
        },
      })
    ).rejects.toThrow("unconfirmed");
    expect(executions).toBe(1);
  }
});
