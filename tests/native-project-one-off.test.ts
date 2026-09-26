import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeProjectOneOff } from "../src/backends/native-project-one-off.ts";
import {
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
const selection = {
  ...run,
  plan: run.planId,
  service: "db-ops",
  generation: "e".repeat(64),
  boot: "boot",
};
const completion = {
  job: "f".repeat(32),
  cleanup_confirmed: true,
  exit_code: 7,
  stdout_base64: "AP8=",
  stderr_base64: "ZXJy",
  truncated: false,
};
async function fixture(saved = true) {
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-one-off-"))
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
  return {
    scope,
    runtime: { binary: "/not-invoked", home: nativeHome },
    service: "db-ops",
    composeFile: join(projectDir, "docker-compose.yml"),
    environment: async () => ({ TOKEN: "synthetic-private-value" }),
  };
}

test("one-off preserves default command or literal argv and fresh private delivery", async () => {
  const opts = await fixture();
  for (const argv of [[], ["/bin/echo", "a b", "$(literal)"]]) {
    let calls = 0;
    let payload: Uint8Array | undefined;
    const result = await nativeProjectOneOff({
      ...opts,
      argv,
      workdir: "/app",
      invoke: async (request) => {
        calls++;
        if (request.args[1] === "run-selection") {
          return selection;
        }
        expect(request.args[1]).toBe("run-service");
        expect(request.args.slice(request.args.indexOf("--") + 1)).toEqual(
          argv
        );
        expect(request.args).toContain("/app");
        expect(request.args.join(" ")).not.toContain("synthetic-private-value");
        payload = request.privateInput;
        expect(JSON.parse(new TextDecoder().decode(payload)).services).toEqual({
          "db-ops": { TOKEN: "synthetic-private-value" },
        });
        return completion;
      },
    });
    expect(calls).toBe(2);
    expect(payload?.every((byte) => byte === 0)).toBe(true);
    expect(result).toEqual({
      exitCode: 7,
      stdout: Buffer.from([0, 255]),
      stderr: Buffer.from("err"),
      truncated: false,
    });
  }
});
test("stale selection and missing project never request a job", async () => {
  const opts = await fixture();
  let mutations = 0;
  await expect(
    nativeProjectOneOff({
      ...opts,
      argv: [],
      invoke: async (request) => {
        if (request.args[1] !== "run-selection") {
          mutations++;
        }
        return { ...selection, plan: "0".repeat(64) };
      },
    })
  ).rejects.toThrow("unconfirmed");
  expect(mutations).toBe(0);
  await expect(
    nativeProjectOneOff({
      ...(await fixture(false)),
      argv: [],
      invoke: async () => {
        throw new Error("must not invoke");
      },
    })
  ).rejects.toThrow("started project");
});
test("unconfirmed cleanup or transport failure never replays and wipes delivery", async () => {
  for (const failure of ["cleanup", "transport", "base64", "mapping"]) {
    const opts = await fixture();
    let mutations = 0;
    let payload: Uint8Array | undefined;
    await expect(
      nativeProjectOneOff({
        ...opts,
        argv: ["/bin/true"],
        invoke: async (request) => {
          if (request.args[1] === "run-selection") {
            return selection;
          }
          mutations++;
          payload = request.privateInput;
          if (failure === "transport") {
            throw new Error("uncertain");
          }
          if (failure === "mapping") {
            await removeNativeProjectRun({ ...opts.scope, expected: run });
            await saveNativeProjectRun({
              ...opts.scope,
              run: { ...run, run: "1".repeat(32) },
            });
          }
          return {
            ...completion,
            cleanup_confirmed: failure !== "cleanup",
            stdout_base64:
              failure === "base64" ? "invalid!" : completion.stdout_base64,
          };
        },
      })
    ).rejects.toThrow();
    expect(mutations).toBe(1);
    expect(payload?.every((byte) => byte === 0)).toBe(true);
  }
});

test("environment preparation cannot authorize a job after the project mapping changes", async () => {
  const opts = await fixture();
  const calls: string[] = [];
  await expect(
    nativeProjectOneOff({
      ...opts,
      argv: [],
      environment: async () => {
        await removeNativeProjectRun({ ...opts.scope, expected: run });
        await saveNativeProjectRun({
          ...opts.scope,
          run: { ...run, run: "1".repeat(32) },
        });
        return { TOKEN: "fresh-synthetic-value" };
      },
      invoke: async (request) => {
        calls.push(String(request.args[1]));
        return selection;
      },
    })
  ).rejects.toThrow("unconfirmed");
  expect(calls).toEqual(["run-selection"]);
});
