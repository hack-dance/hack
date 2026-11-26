import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeProjectExec } from "../src/backends/native-project-exec.ts";
import { saveNativeProjectRun } from "../src/backends/native-project-run.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";
import { expectClosedRefusal } from "./helpers/closed-refusal.ts";
import { restoreEnv } from "./helpers/env.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

let interactiveEnvironment: string | undefined;
beforeEach(() => {
  interactiveEnvironment = process.env.HACK_NO_INTERACTIVE;
  process.env.HACK_NO_INTERACTIVE = "1";
});
afterEach(() => restoreEnv("HACK_NO_INTERACTIVE", interactiveEnvironment));

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
function refreshed() {
  return {
    ok: true,
    ...run,
    plan: run.planId,
    generation: "f".repeat(64),
    changed_slots: [],
  };
}
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
      if (request.args[1] === "refresh-dependencies") {
        return refreshed();
      }
      if (request.args[1] === "status") {
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
  // One lease-free status read first: is the run still warming (PR B)?
  expect(count).toBe(5);
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
  await expectClosedRefusal(
    nativeProjectExec({ ...opts, service: "web", argv: ["true"], invoke }),
    "not been started"
  );
  for (const argv of [[], [""], ["echo", "\0"]]) {
    await expectClosedRefusal(
      nativeProjectExec({ ...opts, service: "web", argv, invoke }),
      "requires"
    );
  }
});
test("dead foreground owner refuses one-off exec before command effects", async () => {
  const opts = await fixture();
  let executions = 0;
  await expectClosedRefusal(
    nativeProjectExec({
      ...opts,
      service: "web",
      argv: ["true"],
      invoke: async (request) => {
        if (request.args[1] === "refresh-dependencies") {
          return refreshed();
        }
        if (request.args[1] === "status") {
          const value = snapshot();
          return {
            ...value,
            receipt: { ...value.receipt, relay_startup: {} },
          };
        }
        if (request.args[1] === "owner-status") {
          throw new Error("graph_owner_recovery");
        }
        executions++;
        throw new Error("unexpected effect");
      },
    }),
    "unconfirmed"
  );
  expect(executions).toBe(0);
});
test("foreign receipt refuses before exec and changed container after exec is uncertain without replay", async () => {
  const opts = await fixture();
  let executions = 0;
  const invoke = async (request: { args: readonly string[] }) => {
    if (request.args[1] === "refresh-dependencies") {
      return refreshed();
    }
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
  await expectClosedRefusal(
    nativeProjectExec({ ...opts, service: "web", argv: ["true"], invoke }),
    "mapping"
  );
  expect(executions).toBe(0);
  await expectClosedRefusal(
    nativeProjectExec({
      ...opts,
      service: "web",
      argv: ["true"],
      invoke: async (request) => {
        if (request.args[1] === "refresh-dependencies") {
          return refreshed();
        }
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
    }),
    "unconfirmed"
  );
  expect(executions).toBe(1);
});

test("native exec rejects env and profile before project lookup or runtime effects", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-exec-flags-"))
  );
  roots.push(root);
  for (const flag of ["--env", "--profile"]) {
    const child = Bun.spawn(
      [process.execPath, "index.ts", "exec", flag, "qa", "web", "true"],
      {
        env: privateCliEnv({
          root,
          env: {
            HACK_RUNTIME_BACKEND: "native",
            HACK_NATIVE_HOME: "/nonexistent-native-home",
            HACK_NATIVE_BINARY: "/nonexistent-native-binary",
          },
        }),
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
    await expectClosedRefusal(
      nativeProjectExec({
        ...opts,
        service: "web",
        argv: ["true"],
        invoke: async (request) => {
          if (request.args[1] === "refresh-dependencies") {
            return refreshed();
          }
          if (request.args[1] === "status") {
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
      }),
      "unconfirmed"
    );
    expect(executions).toBe(1);
  }
});

async function freshFixture(values: Record<string, string>) {
  const opts = await fixture(false);
  await saveNativeProjectRun({
    ...opts.scope,
    run: { ...run, effectiveEnvName: null, aws: null },
  });
  const composeFile = join(opts.scope.projectDir, "docker-compose.yml");
  await writeFile(composeFile, "services:\n  web:\n    image: fixture\n");
  await writeFile(
    join(opts.scope.projectDir, "hack.env.default.yaml"),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: { global: values },
    })
  );
  return { ...opts, composeFile };
}
function selection() {
  return {
    ...run,
    plan: run.planId,
    service: "web",
    container: id,
    generation: "f".repeat(64),
    boot: "fixture-boot",
  };
}
test("fresh exec sends environment only through private stdin and clears its buffer", async () => {
  const opts = await freshFixture({ FIXTURE: "private-fixture-value" });
  let payload: Uint8Array | undefined;
  let executions = 0;
  const calls: string[] = [];
  const result = await nativeProjectExec({
    ...opts,
    service: "web",
    argv: ["/bin/true"],
    invoke: async (request) => {
      calls.push(String(request.args[1]));
      if (request.args[1] === "refresh-dependencies") {
        expect(request.privateInput).toBeUndefined();
        return { ...refreshed(), changed_slots: [0, 3] };
      }
      if (request.args[1] === "status") {
        return snapshot();
      }
      if (request.args[1] === "exec-selection") {
        return selection();
      }
      executions++;
      expect(request.args).toContain("--environment-stdin");
      expect(request.args.join(" ")).not.toContain("private-fixture-value");
      payload = request.privateInput;
      expect(JSON.parse(Buffer.from(payload!).toString()).services).toEqual({
        web: { FIXTURE: "private-fixture-value" },
      });
      return {
        exit_code: 7,
        stdout_base64: "",
        stderr_base64: "",
        truncated: false,
      };
    },
  });
  expect(result.exitCode).toBe(7);
  expect(executions).toBe(1);
  expect(calls).toEqual([
    "status",
    "refresh-dependencies",
    "status",
    "exec-selection",
    "exec",
    "status",
  ]);
  expect(payload?.every((byte) => byte === 0)).toBe(true);
});
test("empty managed environment uses ordinary exec without a private launcher", async () => {
  const opts = await freshFixture({});
  await nativeProjectExec({
    ...opts,
    service: "web",
    argv: ["/bin/true"],
    invoke: async (request) => {
      if (request.args[1] === "refresh-dependencies") {
        return refreshed();
      }
      if (request.args[1] === "status") {
        return snapshot();
      }
      if (request.args[1] === "exec-selection") {
        return selection();
      }
      expect(request.privateInput).toBeUndefined();
      expect(request.args).not.toContain("--environment-stdin");
      return {
        exit_code: 0,
        stdout_base64: "",
        stderr_base64: "",
        truncated: false,
      };
    },
  });
});

test("fresh exec clears private input on transport failure and never retries", async () => {
  const opts = await freshFixture({ FIXTURE: "private-fixture-value" });
  let payload: Uint8Array | undefined;
  let executions = 0;
  await expect(
    nativeProjectExec({
      ...opts,
      service: "web",
      argv: ["/bin/true"],
      invoke: async (request) => {
        if (request.args[1] === "refresh-dependencies") {
          return refreshed();
        }
        if (request.args[1] === "status") {
          return snapshot();
        }
        if (request.args[1] === "exec-selection") {
          return selection();
        }
        executions++;
        payload = request.privateInput;
        throw new Error("transport failure");
      },
    })
  ).rejects.toThrow();
  expect(executions).toBe(1);
  expect(payload?.every((byte) => byte === 0)).toBe(true);
});

test("changed exec selection refuses before private environment delivery", async () => {
  const opts = await freshFixture({ FIXTURE: "private-fixture-value" });
  let executions = 0;
  await expectClosedRefusal(
    nativeProjectExec({
      ...opts,
      service: "web",
      argv: ["/bin/true"],
      invoke: async (request) => {
        if (request.args[1] === "refresh-dependencies") {
          return refreshed();
        }
        if (request.args[1] === "status") {
          return snapshot();
        }
        if (request.args[1] === "exec-selection") {
          return { ...selection(), container: "0".repeat(64) };
        }
        executions++;
        throw new Error("unexpected execution");
      },
    }),
    "unconfirmed"
  );
  expect(executions).toBe(0);
});

test("failed dependency refresh refuses before exec inspection or private preparation without replay", async () => {
  const opts = await freshFixture({ FIXTURE: "private-fixture-value" });
  await writeFile(
    join(opts.scope.projectDir, "hack.env.default.yaml"),
    "malformed: ["
  );
  for (const lostReply of [false, true]) {
    const calls: string[] = [];
    await expect(
      nativeProjectExec({
        ...opts,
        service: "web",
        argv: ["true"],
        invoke: async (request) => {
          calls.push(String(request.args[1]));
          expect(request.privateInput).toBeUndefined();
          if (lostReply) {
            throw new Error("private-synthetic-diagnostic");
          }
          return { ...refreshed(), owner: "0".repeat(32) };
        },
      })
    ).rejects.toThrow("dependency refresh identity or outcome is unconfirmed");
    expect(calls).toEqual(["status", "refresh-dependencies"]);
  }
});

test("exec names an inactive service before sending any command", async () => {
  const opts = await fixture();
  const calls: string[] = [];
  await expect(
    nativeProjectExec({
      ...opts,
      service: "extra",
      argv: ["true"],
      invoke: async (request) => {
        calls.push(request.args[1]!);
        return request.args[1] === "status" ? snapshot() : refreshed();
      },
    })
  ).rejects.toThrow(
    "Native service extra is not active in this run; nothing was executed."
  );
  expect(calls).not.toContain("exec");
});

const PROJECT_STOP =
  "Provider lease acquisition refused; recorded holder: project stop; no operation was admitted.";

test("HACK-2729: an exec that waits out another project's stop prints one progress line", async () => {
  const opts = await fixture();
  const lines: string[] = [];
  const calls: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let result: Awaited<ReturnType<typeof nativeProjectExec>>;
  try {
    result = await nativeProjectExec({
      ...opts,
      service: "web",
      argv: ["true"],
      invoke: async (request) => {
        calls.push(String(request.args[1]));
        if (request.args[1] === "status") {
          expect(request.onLeaseWait).toBeUndefined();
          return snapshot();
        }
        // Both lease-taking requests ask for the report and share one line.
        expect(request.onLeaseWait).toBeInstanceOf(Function);
        request.onLeaseWait?.("project-stop");
        if (request.args[1] === "refresh-dependencies") {
          expect(request.timeoutMs).toBe(220_000);
          return refreshed();
        }
        expect(request.timeoutMs).toBe(95_000);
        return {
          exit_code: 0,
          stdout_base64: "",
          stderr_base64: "",
          truncated: false,
        };
      },
    });
  } finally {
    process.stderr.write = originalWrite;
  }
  expect(result.exitCode).toBe(0);
  expect(calls).toEqual([
    "status",
    "refresh-dependencies",
    "status",
    "exec",
    "status",
  ]);
  expect(lines).toEqual([
    "Waiting for the native runtime lock, held by a project stop. This command continues once it is released (up to 35 s).\n",
  ]);
});

test("HACK-2729: a lock held past the bound refuses clearly before anything ran, never unconfirmed", async () => {
  // At the refresh: nothing was sent to the owner, and exec was never requested.
  const opts = await fixture();
  const calls: string[] = [];
  const busy = () =>
    new NativeRuntimeRequestError({
      message: "private stderr",
      nativeCode: "provider_busy",
      nativeMessage: PROJECT_STOP,
    });
  const expected = [
    "hack exec could not acquire the native runtime lock (provider_busy); nothing ran.",
    "Holder: project stop.",
    "Retry hack exec once that project stop finishes.",
  ].join("\n");
  await expect(
    nativeProjectExec({
      ...opts,
      service: "web",
      argv: ["true"],
      onLeaseWait: () => undefined,
      invoke: async (request) => {
        calls.push(String(request.args[1]));
        if (request.args[1] === "status") {
          return snapshot();
        }
        throw busy();
      },
    })
  ).rejects.toThrow(expected);
  expect(calls).toEqual(["status", "refresh-dependencies"]);

  // At the exec's own lease, the first thing `graph exec` takes.
  calls.length = 0;
  let failure: unknown;
  try {
    await nativeProjectExec({
      ...opts,
      service: "web",
      argv: ["true"],
      onLeaseWait: () => undefined,
      invoke: async (request) => {
        calls.push(String(request.args[1]));
        if (request.args[1] === "status") {
          return snapshot();
        }
        if (request.args[1] === "refresh-dependencies") {
          return refreshed();
        }
        throw busy();
      },
    });
  } catch (error) {
    failure = error;
  }
  expect(calls).toEqual(["status", "refresh-dependencies", "status", "exec"]);
  expect((failure as Error).message).toBe(expected);
  expect((failure as Error).message).not.toContain("unconfirmed");

  // A provider_busy the runtime caused or wrapped is passed on unchanged.
  const wrapped = new NativeRuntimeRequestError({
    message: "Native runtime request failed (provider_busy: provider_state)",
    nativeCode: "provider_busy",
    nativeCauseCode: "provider_state",
  });
  await expect(
    nativeProjectExec({
      ...opts,
      service: "web",
      argv: ["true"],
      onLeaseWait: () => undefined,
      invoke: async (request) => {
        if (request.args[1] === "status") {
          return snapshot();
        }
        if (request.args[1] === "refresh-dependencies") {
          return refreshed();
        }
        throw wrapped;
      },
    })
  ).rejects.toBe(wrapped);
});
