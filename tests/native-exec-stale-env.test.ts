import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveNativeAuthoredExecStaleEnvWarning,
  resolveNativeImageExecStaleEnvWarning,
} from "../src/backends/native-exec-stale-env.ts";
import type { NativeProjectInput } from "../src/backends/native-project-input.ts";
import type { NativeProjectRun } from "../src/backends/native-project-run.ts";
import { runNativeProjectExec } from "../src/commands/project-exec-native.ts";
import {
  buildStaleNativeEnvWarning,
  type ComposeEnvFingerprintRecord,
  withComposeServiceEnvFingerprints,
} from "../src/lib/compose-env-fingerprint.ts";
import { tryNativeAuthoredCommand } from "../src/lib/native-authored-command.ts";
import {
  createNativeEnvFingerprintEntry,
  createNativeEnvFingerprintSession,
  evaluateNativeServiceEnvFreshness,
  forgetNativeEnvFingerprint,
  loadNativeEnvFingerprint,
  type NativeEnvFingerprintScope,
  resolveNativeEnvFingerprintPath,
  saveNativeEnvFingerprint,
} from "../src/lib/native-env-fingerprint-state.ts";

const SECRET_BEFORE = "synthetic-native-start-value";
const SECRET_AFTER = "synthetic-native-edited-value";
const KEY = "SYNTHETIC_NATIVE_TOKEN";
const RUN = "a".repeat(32);
const OTHER_RUN = "b".repeat(32);

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function project(): Promise<{
  readonly root: string;
  readonly projectDir: string;
}> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-exec-stale-env-"))
  );
  roots.push(root);
  const projectDir = join(root, ".hack");
  await mkdir(projectDir, { mode: 0o700 });
  return { root, projectDir };
}

function fingerprint(
  env: Readonly<Record<string, Readonly<Record<string, string>>>>,
  services: readonly string[] = Object.keys(env)
): ComposeEnvFingerprintRecord {
  return withComposeServiceEnvFingerprints({
    existing: undefined,
    services,
    envByService: env,
  });
}

function imageScope(projectDir: string, branch: string | null = null) {
  return { projectDir, owner: "image" as const, branch };
}

async function recordImage(opts: {
  readonly projectDir: string;
  readonly run?: string;
  readonly branch?: string | null;
  readonly env: Readonly<Record<string, Readonly<Record<string, string>>>>;
}): Promise<void> {
  await saveNativeEnvFingerprint(
    imageScope(opts.projectDir, opts.branch ?? null),
    createNativeEnvFingerprintEntry({
      owner: "image",
      run: opts.run ?? RUN,
      fingerprint: fingerprint(opts.env),
    })
  );
}

function expectValueFree(text: string): void {
  expect(text).not.toContain(SECRET_BEFORE);
  expect(text).not.toContain(SECRET_AFTER);
  expect(text).not.toContain(KEY);
}

describe("native env fingerprint record", () => {
  test("round-trips a value-free 0600 record per scope", async () => {
    const { projectDir } = await project();
    await recordImage({ projectDir, env: { web: { [KEY]: SECRET_BEFORE } } });

    const path = resolveNativeEnvFingerprintPath(imageScope(projectDir));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expectValueFree(await readFile(path, "utf8"));
    const entry = await loadNativeEnvFingerprint(imageScope(projectDir));
    expect(entry?.run).toBe(RUN);
    expect(
      evaluateNativeServiceEnvFreshness({
        entry,
        run: RUN,
        service: "web",
        currentEnv: { [KEY]: SECRET_BEFORE },
      })
    ).toBe("unchanged");
    expect(
      evaluateNativeServiceEnvFreshness({
        entry,
        run: RUN,
        service: "web",
        currentEnv: { [KEY]: SECRET_AFTER },
      })
    ).toBe("changed");
    // Bound to the run: a record from another run never compares.
    expect(
      evaluateNativeServiceEnvFreshness({
        entry,
        run: OTHER_RUN,
        service: "web",
        currentEnv: { [KEY]: SECRET_AFTER },
      })
    ).toBe("unknown");
  });

  test("scopes do not share records across owners or branches", async () => {
    const { projectDir } = await project();
    await recordImage({ projectDir, env: { web: {} } });

    expect(await loadNativeEnvFingerprint(imageScope(projectDir))).not.toBe(
      null
    );
    expect(
      await loadNativeEnvFingerprint(imageScope(projectDir, "feature"))
    ).toBeNull();
    expect(
      await loadNativeEnvFingerprint({
        projectDir,
        owner: "authored",
        branch: null,
      })
    ).toBeNull();
  });

  test("malformed, foreign or tampered records read as absent", async () => {
    const { projectDir } = await project();
    const scope = imageScope(projectDir);
    await recordImage({ projectDir, env: { web: {} } });
    const path = resolveNativeEnvFingerprintPath(scope);
    const valid = JSON.parse(await readFile(path, "utf8"));
    for (const tampered of [
      "not json",
      JSON.stringify({ ...valid, version: 2 }),
      JSON.stringify({ ...valid, owner: "authored" }),
      JSON.stringify({ ...valid, run: "../../etc" }),
      JSON.stringify({ ...valid, selection: { overlay: "Bad Name" } }),
      JSON.stringify({ ...valid, selection: { extra: true } }),
      JSON.stringify({
        ...valid,
        fingerprint: { ...valid.fingerprint, salt: "short" },
      }),
    ]) {
      await writeFile(path, tampered);
      expect(await loadNativeEnvFingerprint(scope)).toBeNull();
    }
  });

  test("forget with a salt removes only the caller's own record", async () => {
    const { projectDir } = await project();
    const scope = imageScope(projectDir);
    await recordImage({ projectDir, env: { web: {} } });
    const first = await loadNativeEnvFingerprint(scope);
    await recordImage({ projectDir, run: OTHER_RUN, env: { web: {} } });

    await forgetNativeEnvFingerprint(scope, {
      salt: first?.fingerprint.salt ?? "",
    });
    expect((await loadNativeEnvFingerprint(scope))?.run).toBe(OTHER_RUN);

    await forgetNativeEnvFingerprint(scope);
    expect(await loadNativeEnvFingerprint(scope)).toBeNull();
    // Forgetting an absent record is a no-op, not a failure.
    await forgetNativeEnvFingerprint(scope);
  });

  test("a session records, drops on restart, and releases only its own record", async () => {
    const { projectDir } = await project();
    const scope: NativeEnvFingerprintScope = imageScope(projectDir);
    const previous = createNativeEnvFingerprintSession(scope);
    await previous.record(
      createNativeEnvFingerprintEntry({
        owner: "image",
        run: RUN,
        fingerprint: fingerprint({ web: {} }),
      })
    );
    expect((await loadNativeEnvFingerprint(scope))?.run).toBe(RUN);

    // A restart drops the stale record once the previous run is stopping.
    const restart = createNativeEnvFingerprintSession(scope);
    restart.drop();
    restart.capture(
      createNativeEnvFingerprintEntry({
        owner: "image",
        run: OTHER_RUN,
        fingerprint: fingerprint({ web: {} }),
      })
    );
    restart.commit();
    // The committed write is queued off the synchronous observer.
    let current = await loadNativeEnvFingerprint(scope);
    for (
      let attempt = 0;
      attempt < 50 && current?.run !== OTHER_RUN;
      attempt++
    ) {
      await Bun.sleep(5);
      current = await loadNativeEnvFingerprint(scope);
    }
    expect(current?.run).toBe(OTHER_RUN);
    // The previous foreground exits late; its release must not remove ours.
    await previous.release();
    expect((await loadNativeEnvFingerprint(scope))?.run).toBe(OTHER_RUN);
    await restart.release();
    expect(await loadNativeEnvFingerprint(scope)).toBeNull();
  });

  test("a restart that never becomes ready leaves no record", async () => {
    const { projectDir } = await project();
    const scope = imageScope(projectDir);
    await recordImage({ projectDir, env: { web: {} } });
    const restart = createNativeEnvFingerprintSession(scope);
    restart.drop();
    // Captured at delivery, but never committed: the run never became ready.
    restart.capture(
      createNativeEnvFingerprintEntry({
        owner: "image",
        run: OTHER_RUN,
        fingerprint: fingerprint({ web: {} }),
      })
    );
    await restart.release();
    expect(await loadNativeEnvFingerprint(scope)).toBeNull();
  });

  test("an unwritable record never fails the session", async () => {
    const { projectDir } = await project();
    await writeFile(join(projectDir, ".internal"), "not a directory");
    const session = createNativeEnvFingerprintSession(imageScope(projectDir));
    await session.record(
      createNativeEnvFingerprintEntry({
        owner: "image",
        run: RUN,
        fingerprint: fingerprint({ web: {} }),
      })
    );
    await session.release();
    expect(await loadNativeEnvFingerprint(imageScope(projectDir))).toBeNull();
  });
});

describe("native stale env warning text", () => {
  test("is closed, names a valid service and suggests a whole-project restart", () => {
    expect(
      buildStaleNativeEnvWarning({ service: "web", exec: "started" })
    ).toBe(
      'Env for service "web" changed since it started; this exec uses the env it started with. Run `hack restart` to apply the current env.'
    );
    expect(buildStaleNativeEnvWarning({ service: "web", exec: "fresh" })).toBe(
      'Env for service "web" changed since it started; the running service still uses the env it started with. Run `hack restart` to apply the current env.'
    );
    expect(
      buildStaleNativeEnvWarning({ service: "$(bad name)", exec: "started" })
    ).toContain("Env for this service changed");
  });
});

function imageMapping(
  overrides: Partial<NativeProjectRun> = {}
): NativeProjectRun {
  return {
    run: RUN,
    owner: "c".repeat(32),
    namespace: "d".repeat(64),
    planId: "e".repeat(64),
    effectiveEnvName: null,
    profiles: [],
    aws: null,
    ...overrides,
  };
}

function preparedInput(
  managedEnvironment: NativeProjectInput["managedEnvironment"],
  effectiveEnvName: string | null = null
): NativeProjectInput {
  return {
    originalSha256: "f".repeat(64),
    normalizedComposeJson: "{}",
    managedEnvironment,
    lifecycleHostEnvironment: {},
    effectiveEnvName,
    environmentFiles: [],
    serviceNames: Object.keys(managedEnvironment),
  };
}

describe("native image exec stale env check", () => {
  async function resolve(opts: {
    readonly projectDir: string;
    readonly root: string;
    readonly mapping?: NativeProjectRun | null;
    readonly current?: NativeProjectInput["managedEnvironment"];
    readonly currentEnvName?: string | null;
    readonly service?: string;
    readonly prepare?: () => Promise<NativeProjectInput>;
  }) {
    const prepared: (string | null | undefined)[] = [];
    const warning = await resolveNativeImageExecStaleEnvWarning({
      scope: {
        projectRoot: opts.root,
        projectDir: opts.projectDir,
        nativeHome: opts.root,
        branch: null,
      },
      service: opts.service ?? "web",
      composeFile: join(opts.projectDir, "docker-compose.yml"),
      loadRun: async () =>
        opts.mapping === undefined ? imageMapping() : opts.mapping,
      prepare:
        opts.prepare ??
        (async (request) => {
          prepared.push(request.envName);
          return preparedInput(
            opts.current ?? { web: { [KEY]: SECRET_BEFORE } },
            opts.currentEnvName ?? null
          );
        }),
    });
    return { warning, prepared };
  }

  test("warns value-free when the selection changed since the run started", async () => {
    const fixture = await project();
    await recordImage({
      projectDir: fixture.projectDir,
      env: { web: { [KEY]: SECRET_BEFORE } },
    });

    const { warning, prepared } = await resolve({
      ...fixture,
      current: { web: { [KEY]: SECRET_AFTER } },
    });

    expect(warning).toBe(
      buildStaleNativeEnvWarning({ service: "web", exec: "fresh" })
    );
    expect(prepared).toEqual([null]);
    expectValueFree(warning ?? "");
  });

  test("negative control: unchanged env does not warn", async () => {
    const fixture = await project();
    await recordImage({
      projectDir: fixture.projectDir,
      env: { web: { [KEY]: SECRET_BEFORE } },
    });

    expect((await resolve(fixture)).warning).toBeNull();
  });

  test("an added key on a service that started with no env warns", async () => {
    const fixture = await project();
    await recordImage({ projectDir: fixture.projectDir, env: { web: {} } });

    expect(
      (await resolve({ ...fixture, current: { web: { [KEY]: SECRET_AFTER } } }))
        .warning
    ).not.toBeNull();
  });

  test("no record, another run, a legacy mapping or a changed env name stay silent", async () => {
    const fixture = await project();
    const changed = { web: { [KEY]: SECRET_AFTER } };
    const none = await resolve({ ...fixture, current: changed });
    expect(none).toEqual({ warning: null, prepared: [] });

    await recordImage({
      projectDir: fixture.projectDir,
      env: { web: { [KEY]: SECRET_BEFORE } },
    });
    expect(
      await resolve({
        ...fixture,
        current: changed,
        mapping: imageMapping({ run: OTHER_RUN }),
      })
    ).toEqual({ warning: null, prepared: [] });
    expect(
      await resolve({ ...fixture, current: changed, mapping: null })
    ).toEqual({ warning: null, prepared: [] });
    const { effectiveEnvName: _legacy, ...legacy } = imageMapping();
    expect(
      await resolve({ ...fixture, current: changed, mapping: legacy })
    ).toEqual({ warning: null, prepared: [] });
    expect(
      (await resolve({ ...fixture, current: changed, currentEnvName: "qa" }))
        .warning
    ).toBeNull();
    expect(
      (await resolve({ ...fixture, current: changed, service: "worker" }))
        .warning
    ).toBeNull();
  });

  test("a resolution failure stays silent", async () => {
    const fixture = await project();
    await recordImage({
      projectDir: fixture.projectDir,
      env: { web: { [KEY]: SECRET_BEFORE } },
    });

    expect(
      (
        await resolve({
          ...fixture,
          prepare: () => Promise.reject(new Error(SECRET_AFTER)),
        })
      ).warning
    ).toBeNull();
  });
});

describe("native image exec output", () => {
  function captured() {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const out = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const err = spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    return {
      stdout,
      stderr,
      restore: () => {
        out.mockRestore();
        err.mockRestore();
      },
    };
  }

  const scope = {
    projectRoot: "/synthetic/project",
    projectDir: "/synthetic/project/.hack",
    nativeHome: "/synthetic/native-home",
    branch: null,
  };

  test("writes the warning to stderr ahead of the captured output; stdout stays the command's", async () => {
    const io = captured();
    let code: number;
    try {
      code = await runNativeProjectExec({
        runtime: { binary: "/synthetic/hack-native", home: scope.nativeHome },
        scope,
        service: "web",
        argv: ["printenv"],
        workdir: undefined,
        composeFile: "/synthetic/project/.hack/docker-compose.yml",
        exec: async () => ({
          exitCode: 3,
          stdout: Buffer.from("command-out\n"),
          stderr: Buffer.from("command-err\n"),
          truncated: false,
        }),
        staleEnv: async (request) =>
          buildStaleNativeEnvWarning({
            service: request.service,
            exec: "fresh",
          }),
      });
    } finally {
      io.restore();
    }
    expect(code).toBe(3);
    expect(io.stdout).toEqual(["command-out\n"]);
    expect(io.stderr).toEqual([
      `WARNING: ${buildStaleNativeEnvWarning({ service: "web", exec: "fresh" })}\n`,
      "command-err\n",
    ]);
  });

  test("negative control: no warning when unchanged, and none for a refused exec", async () => {
    const io = captured();
    let checks = 0;
    try {
      await runNativeProjectExec({
        runtime: { binary: "/synthetic/hack-native", home: scope.nativeHome },
        scope,
        service: "web",
        argv: ["true"],
        workdir: undefined,
        composeFile: "/synthetic/project/.hack/docker-compose.yml",
        exec: async () => ({
          exitCode: 0,
          stdout: Buffer.from(""),
          stderr: Buffer.from(""),
          truncated: false,
        }),
        staleEnv: async () => {
          checks++;
          return null;
        },
      });
      await expect(
        runNativeProjectExec({
          runtime: {
            binary: "/synthetic/hack-native",
            home: scope.nativeHome,
          },
          scope,
          service: "web",
          argv: ["true"],
          workdir: undefined,
          composeFile: "/synthetic/project/.hack/docker-compose.yml",
          exec: () => Promise.reject(new Error("refused")),
          staleEnv: async () => {
            checks++;
            return "unexpected";
          },
        })
      ).rejects.toThrow("refused");
    } finally {
      io.restore();
    }
    expect(checks).toBe(1);
    expect(io.stderr.join("")).not.toContain("WARNING");
  });
});

describe("authored native exec stale env check", () => {
  function authoredScope(root: string, projectDir: string) {
    return {
      projectRoot: root,
      projectDir,
      nativeHome: join(root, "candidate"),
      branch: "feature",
    };
  }

  async function recordAuthored(opts: {
    readonly projectDir: string;
    readonly env: Readonly<Record<string, Readonly<Record<string, string>>>>;
  }): Promise<void> {
    await saveNativeEnvFingerprint(
      { projectDir: opts.projectDir, owner: "authored", branch: "feature" },
      createNativeEnvFingerprintEntry({
        owner: "authored",
        run: RUN,
        fingerprint: fingerprint(opts.env),
        selection: { overlay: "qa", profiles: ["extra"] },
      })
    );
  }

  test("warns when the recorded selection resolves differently now", async () => {
    const { root, projectDir } = await project();
    await recordAuthored({
      projectDir,
      env: { web: { [KEY]: SECRET_BEFORE }, worker: {} },
    });
    const selections: unknown[] = [];

    const warning = await resolveNativeAuthoredExecStaleEnvWarning({
      scope: authoredScope(root, projectDir),
      service: "web",
      currentRun: async () => RUN,
      resolveEnvironment: async (request) => {
        selections.push(request.selection);
        return { web: { [KEY]: SECRET_AFTER }, worker: {} };
      },
    });

    expect(warning).toBe(
      buildStaleNativeEnvWarning({ service: "web", exec: "started" })
    );
    // The same public selectors startup used are resolved again.
    expect(selections).toEqual([{ overlay: "qa", profiles: ["extra"] }]);
    expectValueFree(warning ?? "");
  });

  test("negative control: unchanged env, another run, or no record stay silent", async () => {
    const { root, projectDir } = await project();
    const scope = authoredScope(root, projectDir);
    let resolutions = 0;
    const resolveEnvironment = async () => {
      resolutions++;
      return { web: { [KEY]: SECRET_BEFORE } };
    };
    expect(
      await resolveNativeAuthoredExecStaleEnvWarning({
        scope,
        service: "web",
        currentRun: async () => RUN,
        resolveEnvironment,
      })
    ).toBeNull();
    expect(resolutions).toBe(0);

    await recordAuthored({
      projectDir,
      env: { web: { [KEY]: SECRET_BEFORE } },
    });
    expect(
      await resolveNativeAuthoredExecStaleEnvWarning({
        scope,
        service: "web",
        currentRun: async () => RUN,
        resolveEnvironment,
      })
    ).toBeNull();
    expect(resolutions).toBe(1);
    expect(
      await resolveNativeAuthoredExecStaleEnvWarning({
        scope,
        service: "web",
        currentRun: async () => OTHER_RUN,
        resolveEnvironment: async () => ({ web: { [KEY]: SECRET_AFTER } }),
      })
    ).toBeNull();
    expect(
      await resolveNativeAuthoredExecStaleEnvWarning({
        scope,
        service: "web",
        currentRun: async () => RUN,
        resolveEnvironment: () => Promise.reject(new Error(SECRET_AFTER)),
      })
    ).toBeNull();
  });
});

const macTest = process.platform === "darwin" ? test : test.skip;

describe("authored native command wiring", () => {
  async function fixture() {
    const { root, projectDir } = await project();
    const nativeHome = join(root, "candidate");
    await mkdir(nativeHome, { mode: 0o700 });
    return {
      root,
      projectDir,
      selected: { kind: "native" as const, projectRoot: root },
      env: {
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_BINARY: join(root, "explicit-native"),
        HACK_NATIVE_HOME: nativeHome,
        HACK_COMPOSE_STARTUP_TIMEOUT_MS: "1500",
      },
    };
  }

  macTest(
    "exec writes the warning to stderr before the command's output",
    async () => {
      const selected = await fixture();
      const stderr: string[] = [];
      const err = spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
      const writes = spyOn(Bun, "write").mockImplementation(async () => 0);
      let code: number | null;
      try {
        code = await tryNativeAuthoredCommand({
          selected: selected.selected,
          env: selected.env,
          options: {
            cwd: selected.root,
            operation: "exec",
            service: "web",
            command: ["printenv"],
          },
          exec: async () => ({
            backend: "native",
            run: RUN,
            service: "web",
            container: "f".repeat(64),
            exitCode: 0,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            truncated: false,
          }),
          staleEnv: async (request) =>
            buildStaleNativeEnvWarning({
              service: request.service,
              exec: "started",
            }),
        });
      } finally {
        err.mockRestore();
        writes.mockRestore();
      }
      expect(code).toBe(0);
      expect(stderr).toEqual([
        `WARNING: ${buildStaleNativeEnvWarning({ service: "web", exec: "started" })}\n`,
      ]);
    }
  );

  function execCompletion(stdout: string) {
    return async () => ({
      backend: "native" as const,
      run: RUN,
      service: "web",
      container: "f".repeat(64),
      exitCode: 4,
      stdout: new TextEncoder().encode(stdout),
      stderr: new Uint8Array(),
      truncated: false,
    });
  }

  macTest(
    "Ctrl-C during the advisory check returns 130 without waiting for it or writing output",
    async () => {
      const selected = await fixture();
      const stderr: string[] = [];
      const err = spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
      const writes = spyOn(Bun, "write").mockImplementation(async () => 0);
      const received: { signal?: AbortSignal } = {};
      let code: number | null;
      try {
        code = await tryNativeAuthoredCommand({
          selected: selected.selected,
          env: selected.env,
          options: {
            cwd: selected.root,
            operation: "exec",
            service: "web",
            command: ["printenv"],
          },
          exec: execCompletion("command-out\n"),
          staleEnv: (request) => {
            received.signal = request.signal;
            process.emit("SIGINT");
            // A resolution that ignores cancellation must not hold the exec.
            return new Promise<string | null>(() => undefined);
          },
        });
      } finally {
        err.mockRestore();
        writes.mockRestore();
      }
      expect(code).toBe(130);
      expect(received.signal?.aborted).toBe(true);
      expect(writes).not.toHaveBeenCalled();
      expect(stderr).toEqual([]);
    },
    2000
  );

  macTest(
    "a slow advisory check is time-bounded: the exec output follows without a warning",
    async () => {
      const selected = await fixture();
      const stderr: string[] = [];
      const err = spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
      const written: string[] = [];
      const writes = spyOn(Bun, "write").mockImplementation(
        async (_destination, data) => {
          written.push(new TextDecoder().decode(data as Uint8Array));
          return 0;
        }
      );
      const received: { signal?: AbortSignal } = {};
      let code: number | null;
      try {
        code = await tryNativeAuthoredCommand({
          selected: selected.selected,
          env: selected.env,
          options: {
            cwd: selected.root,
            operation: "exec",
            service: "web",
            command: ["printenv"],
          },
          exec: execCompletion("command-out\n"),
          staleEnvTimeoutMs: 25,
          staleEnv: (request) => {
            received.signal = request.signal;
            return new Promise<string | null>(() => undefined);
          },
        });
      } finally {
        err.mockRestore();
        writes.mockRestore();
      }
      expect(code).toBe(4);
      expect(received.signal?.aborted).toBe(true);
      expect(written).toEqual(["command-out\n", ""]);
      expect(stderr).toEqual([]);
    },
    2000
  );

  macTest(
    "negative control: a warning resolved after the bound, or a failed check, is dropped",
    async () => {
      const selected = await fixture();
      const stderr: string[] = [];
      const err = spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });
      const writes = spyOn(Bun, "write").mockImplementation(async () => 0);
      let code: number | null;
      let failedCode: number | null;
      try {
        failedCode = await tryNativeAuthoredCommand({
          selected: selected.selected,
          env: selected.env,
          options: {
            cwd: selected.root,
            operation: "exec",
            service: "web",
            command: ["printenv"],
          },
          exec: execCompletion(""),
          staleEnv: () => Promise.reject(new Error(SECRET_AFTER)),
        });
        code = await tryNativeAuthoredCommand({
          selected: selected.selected,
          env: selected.env,
          options: {
            cwd: selected.root,
            operation: "exec",
            service: "web",
            command: ["printenv"],
          },
          exec: execCompletion(""),
          staleEnvTimeoutMs: 25,
          staleEnv: (request) =>
            new Promise<string | null>((resolve) => {
              request.signal?.addEventListener("abort", () =>
                resolve(
                  buildStaleNativeEnvWarning({
                    service: request.service,
                    exec: "started",
                  })
                )
              );
            }),
        });
      } finally {
        err.mockRestore();
        writes.mockRestore();
      }
      expect(failedCode).toBe(4);
      expect(code).toBe(4);
      expect(stderr).toEqual([]);
    },
    2000
  );

  macTest(
    "up records the delivered selection while ready and removes it on exit",
    async () => {
      const selected = await fixture();
      const scope = {
        projectDir: selected.projectDir,
        owner: "authored" as const,
        branch: null,
      };
      const observed: {
        entry: Awaited<ReturnType<typeof loadNativeEnvFingerprint>>;
      } = { entry: null };
      const code = await tryNativeAuthoredCommand({
        selected: selected.selected,
        env: selected.env,
        options: { cwd: selected.root, operation: "up", overlay: "qa" },
        serve: async (request) => {
          request.onEnvironmentSelected?.(
            fingerprint({ web: { [KEY]: SECRET_BEFORE } })
          );
          request.onReady?.(
            {} as Parameters<NonNullable<typeof request.onReady>>[0]
          );
          // The ready record is written off the synchronous observer.
          for (let attempt = 0; attempt < 50 && !observed.entry; attempt++) {
            await Bun.sleep(5);
            observed.entry = await loadNativeEnvFingerprint(scope);
          }
          expect(observed.entry?.run).toBe(request.run);
          return 0;
        },
      });
      expect(code).toBe(0);
      expect(observed.entry?.selection).toEqual({ overlay: "qa" });
      expectValueFree(JSON.stringify(observed.entry));
      expect(await loadNativeEnvFingerprint(scope)).toBeNull();
    }
  );

  macTest(
    "negative control: a run that never becomes ready records nothing",
    async () => {
      const selected = await fixture();
      const code = await tryNativeAuthoredCommand({
        selected: selected.selected,
        env: selected.env,
        options: { cwd: selected.root, operation: "up" },
        serve: async (request) => {
          request.onEnvironmentSelected?.(fingerprint({ web: {} }));
          return 0;
        },
      });
      expect(code).toBe(0);
      expect(await readdir(selected.projectDir)).toEqual([]);
    }
  );

  macTest(
    "a failed restart start drops the previous run's record",
    async () => {
      const selected = await fixture();
      const scope = {
        projectDir: selected.projectDir,
        owner: "authored" as const,
        branch: null,
      };
      await saveNativeEnvFingerprint(
        scope,
        createNativeEnvFingerprintEntry({
          owner: "authored",
          run: RUN,
          fingerprint: fingerprint({ web: { [KEY]: SECRET_BEFORE } }),
        })
      );
      await expect(
        tryNativeAuthoredCommand({
          selected: selected.selected,
          env: selected.env,
          options: { cwd: selected.root, operation: "restart" },
          stop: async () => undefined,
          serve: async (request) => {
            request.onEnvironmentSelected?.(fingerprint({ web: {} }));
            throw new Error("synthetic start failure");
          },
        })
      ).rejects.toThrow();
      expect(await loadNativeEnvFingerprint(scope)).toBeNull();
    }
  );
});
