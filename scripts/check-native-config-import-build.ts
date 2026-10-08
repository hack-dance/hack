#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, posix, resolve } from "node:path";
import { isRecord } from "../src/lib/guards.ts";
import { renderNativeCompose } from "../src/lib/native-compose-renderer.ts";
import { compileNativeConfig } from "../src/lib/native-config-compiler.ts";
import { mapLegacyNativeImport } from "../src/lib/native-config-import-plan.ts";
import { resolveTestConfigCompilerBinary } from "./check-test-config-compiler.ts";

const CASES = {
  default: { build: {} },
  root: { build: ".." },
  nested: {
    build: {
      context: "../app",
      dockerfile: "./docker/Dockerfile",
      target: "selected",
    },
    pull_policy: "build",
  },
  literal: {
    build: {
      context: "../literal-$${AMBIENT}",
      dockerfile: "docker/Dockerfile-$${AMBIENT}",
    },
    profiles: ["later"],
  },
};
const LIMIT = 256 * 1024;
const RUNTIME = "import-build-fixture";

function requireValue(value: unknown): asserts value {
  if (!value) {
    throw new Error("Build import config-only correspondence refused.");
  }
}

function record(value: unknown): Record<string, unknown> {
  requireValue(isRecord(value));
  return value;
}

/** Exact source/stage/policy and resolved path projection; Compose keeps some lexical Dockerfile spelling. */
export function nativeImportBuildProjection(value: unknown) {
  const services = record(record(value).services);
  requireValue(
    Object.keys(services).sort().join(",") ===
      Object.keys(CASES).sort().join(",")
  );
  return Object.fromEntries(
    Object.entries(services)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => {
        const service = record(value);
        requireValue(
          Object.hasOwn(service, "build") && !Object.hasOwn(service, "image")
        );
        const build = record(service.build);
        requireValue(
          Object.hasOwn(build, "context") &&
            Object.hasOwn(build, "dockerfile") &&
            Object.keys(build).every((key) =>
              ["context", "dockerfile", "target"].includes(key)
            ) &&
            typeof build.context === "string" &&
            posix.isAbsolute(build.context) &&
            typeof build.dockerfile === "string" &&
            !posix.isAbsolute(build.dockerfile) &&
            !/[\\\0\r\n]/.test(build.context + build.dockerfile) &&
            (!Object.hasOwn(build, "target") ||
              typeof build.target === "string") &&
            (!Object.hasOwn(service, "pull_policy") ||
              service.pull_policy === "build")
        );
        return [
          name,
          {
            context: posix.normalize(build.context),
            dockerfile: posix.join(build.context, build.dockerfile),
            ...(Object.hasOwn(build, "target") ? { target: build.target } : {}),
            ...(Object.hasOwn(service, "pull_policy")
              ? { pull_policy: service.pull_policy }
              : {}),
          },
        ];
      })
  );
}

function expected(project: string) {
  const value = (context: string, dockerfile = "Dockerfile") => ({
    context: posix.join(project, context),
    dockerfile: posix.join(project, context, dockerfile),
  });
  return {
    default: value(".hack"),
    // Compose config serializes the literal dollar as an escaped dollar pair.
    literal: value("literal-$${AMBIENT}", "docker/Dockerfile-$${AMBIENT}"),
    nested: {
      ...value("app", "docker/Dockerfile"),
      target: "selected",
      pull_policy: "build",
    },
    root: value("."),
  };
}

function capture(
  stream: ReadableStream<Uint8Array>,
  stop: () => void,
  afterRead?: () => void
) {
  const reader = stream.getReader();
  const value = (async () => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        size += next.value.length;
        requireValue(size <= LIMIT);
        afterRead?.();
        chunks.push(next.value);
      }
      return Buffer.concat(chunks);
    } catch {
      stop();
      throw new Error("Bounded config-only capture refused.");
    } finally {
      reader.releaseLock();
    }
  })();
  return {
    value,
    cancel: async () => {
      try {
        await reader.cancel();
      } catch {
        // The owned read may already have settled and released its lock.
      }
    },
  };
}

/** Bounded config-only command owner. Leader exit alone never disarms pending-pipe cleanup. */
export async function runNativeImportBuildConfig(opts: {
  readonly binary: string;
  readonly file: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Focused capture-failure control; never selected from authored or CLI input. */
  readonly afterRead?: () => void;
  /** Private bounded captures, delivered only after the direct child and both pipes settle. */
  readonly onSettled?: (result: {
    readonly exitCode: number;
    readonly stdout: Uint8Array;
    readonly stderr: Uint8Array;
  }) => Promise<void>;
}) {
  requireValue(
    isAbsolute(opts.binary) &&
      opts.timeoutMs > 0 &&
      opts.timeoutMs <= 15_000 &&
      !opts.signal?.aborted
  );
  const deadline = Date.now() + opts.timeoutMs;
  const child = Bun.spawn(
    [
      opts.binary,
      "--project-name",
      RUNTIME,
      "--project-directory",
      opts.cwd,
      "--env-file",
      "/dev/null",
      "--file",
      opts.file,
      "--profile",
      "*",
      "config",
      "--format",
      "json",
    ],
    {
      cwd: opts.cwd,
      env: { ...opts.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    }
  );
  let complete = false;
  let stopped = false;
  let output: ReturnType<typeof capture> | undefined;
  let errors: ReturnType<typeof capture> | undefined;
  const stop = () => {
    if (!(complete || stopped)) {
      stopped = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error: unknown) {
        if (!(isRecord(error) && error.code === "ESRCH")) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Unknown cleanup cannot succeed; the direct child remains awaited.
          }
        }
      }
    }
    // Cancellation closes descendant-held pipes independently of the signal guard.
    void output?.cancel();
    void errors?.cancel();
  };
  const timer = setTimeout(stop, opts.timeoutMs);
  opts.signal?.addEventListener("abort", stop, { once: true });
  const exit = child.exited;
  output = capture(child.stdout, stop, opts.afterRead);
  errors = capture(child.stderr, stop, opts.afterRead);
  const pending = [exit, output.value, errors.value] as const;
  try {
    const [code, out, err] = await Promise.all(pending);
    // Disarm former-group signals before decoding, publication or final assertions.
    complete = true;
    await opts.onSettled?.({ exitCode: code, stdout: out, stderr: err });
    requireValue(
      code === 0 && !stopped && !opts.signal?.aborted && Date.now() < deadline
    );
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return { stdout: decoder.decode(out), stderr: decoder.decode(err) };
  } catch {
    stop();
    await Promise.allSettled(pending);
    throw new Error(
      "Config-only Compose correspondence failed; values omitted."
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", stop);
  }
}

async function main() {
  const deadline = Date.now() + 90_000;
  const binary = resolveTestConfigCompilerBinary({
    override: process.env.HACK_CONFIG_COMPILER_BINARY,
  });
  const compose = process.env.HACK_IMPORT_COMPOSE_BINARY;
  requireValue(compose && isAbsolute(compose));
  const physical = await realpath(compose);
  const composeInfo = await lstat(physical);
  const compilerInfo = await lstat(binary);
  requireValue(
    composeInfo.isFile() &&
      composeInfo.nlink === 1 &&
      composeInfo.mode & 0o111 &&
      compilerInfo.isFile() &&
      compilerInfo.mode & 0o111
  );
  const pins = {
    compiler: createHash("sha256")
      .update(Buffer.from(await Bun.file(binary).arrayBuffer()))
      .digest("hex"),
    compose: createHash("sha256")
      .update(Buffer.from(await Bun.file(physical).arrayBuffer()))
      .digest("hex"),
  };
  const evidence = process.env.HACK_IMPORT_BUILD_EVIDENCE_DIR;
  let directory: string;
  if (evidence) {
    requireValue(isAbsolute(evidence) && resolve(evidence) === evidence);
    requireValue(
      (await realpath(resolve(evidence, ".."))) === resolve(evidence, "..")
    );
    await mkdir(evidence, { mode: 0o700 });
    directory = evidence;
  } else {
    directory = await realpath(
      await mkdtemp(join(tmpdir(), "native-build-import-"))
    );
  }
  const project = join(directory, "project");
  const home = join(directory, "home");
  await mkdir(join(project, ".hack"), { recursive: true });
  await mkdir(join(home, ".docker"), { recursive: true });
  await writeFile(join(home, ".docker", "config.json"), "{}\n", {
    mode: 0o600,
    flag: "wx",
  });
  const composeFile = join(project, ".hack", "docker-compose.yml");
  const raw = JSON.stringify({ services: CASES });
  await writeFile(composeFile, raw, { mode: 0o600, flag: "wx" });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const remaining = () => {
    requireValue(!controller.signal.aborted && Date.now() < deadline);
    return Math.min(15_000, deadline - Date.now());
  };
  const assertBinaries = async () => {
    remaining();
    requireValue((await realpath(compose)) === physical);
    for (const [path, original, hash] of [
      [binary, compilerInfo, pins.compiler],
      [physical, composeInfo, pins.compose],
    ] as const) {
      const same = async () => {
        const current = await lstat(path);
        requireValue(
          current.isFile() &&
            current.dev === original.dev &&
            current.ino === original.ino &&
            current.size === original.size &&
            current.mode === original.mode &&
            current.nlink === original.nlink &&
            current.mtimeMs === original.mtimeMs &&
            current.ctimeMs === original.ctimeMs
        );
      };
      await same();
      requireValue(
        createHash("sha256")
          .update(Buffer.from(await Bun.file(path).arrayBuffer()))
          .digest("hex") === hash
      );
      await same();
    }
    remaining();
  };
  const config = async (file: string, cwd: string, label: string) => {
    await assertBinaries();
    const captured = await runNativeImportBuildConfig({
      binary: compose,
      file,
      cwd,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        DOCKER_CONFIG: join(home, ".docker"),
        DOCKER_HOST: `unix://${directory}/no-engine.sock`,
        COMPOSE_DISABLE_ENV_FILE: "1",
        AMBIENT: "must-not-expand",
      },
      timeoutMs: remaining(),
      signal: controller.signal,
      onSettled: async (result) => {
        await writeFile(join(directory, `${label}.stdout`), result.stdout, {
          mode: 0o600,
          flag: "wx",
        });
        await writeFile(join(directory, `${label}.stderr`), result.stderr, {
          mode: 0o600,
          flag: "wx",
        });
      },
    });
    remaining();
    requireValue(!captured.stdout.includes("must-not-expand"));
    return JSON.parse(captured.stdout) as unknown;
  };
  let passed = false;
  try {
    const mapped = mapLegacyNativeImport({
      configText: '{"name":"fixture"}',
      composeText: raw,
    });
    requireValue(mapped.report.complete && mapped.candidate);
    await assertBinaries();
    const result = await compileNativeConfig({
      binary,
      input: new TextEncoder().encode(JSON.stringify(mapped.candidate)),
      profiles: ["later"],
      signal: controller.signal,
      timeoutMs: remaining(),
    });
    requireValue(result.ok);
    const workloads = Object.keys(record(result.plan.services));
    requireValue(
      workloads.sort().join(",") === Object.keys(CASES).sort().join(",")
    );
    const rendered = renderNativeCompose({
      plan: result.plan,
      environmentPlan: {
        plan_version: 1,
        overlay: null,
        overlay_exists: false,
        complete: true,
        workloads: Object.fromEntries(workloads.map((name) => [name, {}])),
        warnings: [],
        diagnostics: [],
      },
      projectRoot: project,
      runtimeIdentity: RUNTIME,
      ownerToken: "a".repeat(32),
      generationIdentity: "b".repeat(32),
      declaredWorkloads: result.declared_workloads,
      managedValues: Object.fromEntries(workloads.map((name) => [name, {}])),
    });
    const generated = join(directory, "generated.json");
    await writeFile(generated, rendered.json, { mode: 0o600, flag: "wx" });
    const legacy = nativeImportBuildProjection(
      await config(composeFile, join(project, ".hack"), "legacy")
    );
    const native = nativeImportBuildProjection(
      await config(generated, project, "native")
    );
    requireValue(JSON.stringify(legacy) === JSON.stringify(expected(project)));
    requireValue(JSON.stringify(native) === JSON.stringify(legacy));
    await assertBinaries();
    // A receipt write can finish after cancellation/deadline. It records matching
    // projections only; the caller's final zero exit is required for acceptance.
    await writeFile(
      join(directory, "result.json"),
      JSON.stringify({
        comparison: "matched",
        completion: "requires_final_zero_exit",
        cases: 4,
        pins,
        legacy,
        native,
      }),
      { mode: 0o600, flag: "wx" }
    );
    remaining();
    passed = true;
    process.stdout.write(
      "Basic build import: 4 compiler/Compose config-only cases passed; no engine or build actions.\n"
    );
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    if (passed && !evidence) {
      await rm(directory, { recursive: true });
    }
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    process.stderr.write(
      "Basic build import correspondence failed; private captures retained, values omitted.\n"
    );
    process.exitCode = 1;
  }
}
