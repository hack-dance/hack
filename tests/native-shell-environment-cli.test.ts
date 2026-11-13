import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  mergeNativeShellEnvironment,
  prepareNativeProjectInput,
} from "../src/backends/native-project-input.ts";
import { nativeEnvironmentDelivery } from "../src/backends/native-project-start.ts";
import { nativeSourceSizeReceipt } from "./helpers/native-source-size.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * Shell references in a service's `environment` on the native backend, from
 * the caller's shell to the private delivery.
 *
 * The CLI case runs the source CLI against a stub runtime, so nothing here
 * starts a VM. It shows what a user sees: native `up` gets past its own
 * admission, names an unset variable, and never prints a value. The delivery
 * case shows where the value goes: only into the private stdin payload.
 */

const roots: string[] = [];
const entrypoint = resolve("index.ts");
const SPAWN_TIMEOUT_MS = 60_000;
const IMAGE = `sha256:${"e".repeat(64)}`;
const PRIVATE = "synthetic-shell-private-value";

/** A Compose reference to `name`, built so this file has no template placeholders. */
function reference(name: string): string {
  return `$\{${name}}`;
}

const COMPOSE = {
  services: {
    web: {
      image: IMAGE,
      environment: {
        API_KEY: reference("FIXTURE_API_KEY"),
        REGION: reference("FIXTURE_REGION"),
        PASSED: null,
      },
    },
  },
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-shell-env-cli-"))
  );
  roots.push(root);
  const project = join(root, "project");
  const projectDir = join(project, ".hack");
  const nativeHome = join(root, "native-home");
  const stub = join(root, "stub");
  await mkdir(projectDir, { recursive: true });
  await mkdir(nativeHome, { mode: 0o700 });
  await mkdir(stub);
  const xdg = {
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_STATE_HOME: join(root, "xdg-state"),
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_DATA_HOME: join(root, "xdg-data"),
  };
  const composeFile = join(projectDir, "docker-compose.yml");
  await writeFile(composeFile, JSON.stringify(COMPOSE));
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({ name: "shell-env-fixture" })
  );
  // Native `up` requires the bundled relay artifact next to the runtime binary.
  await writeFile(join(root, "hack-relay-guest"), "synthetic relay");
  const binary = join(root, "native-runtime");
  await writeFile(
    binary,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${stub}/calls'
if [ -f '${stub}/'"$3-$4"'.out' ]; then cat '${stub}/'"$3-$4"'.out'; exit 0; fi
printf '%s' '{"code":"runtime_not_running"}' >&2
exit 1
`,
    { mode: 0o700 }
  );
  await writeFile(
    join(stub, "runtime-check-project-share.out"),
    JSON.stringify({ source_admitted: true, pool_initialized: true })
  );
  await writeFile(
    join(stub, "project-source-size.out"),
    JSON.stringify(nativeSourceSizeReceipt())
  );
  // Replies that carry `up` through the runtime review, where the active
  // services are known and the notices are printed.
  await writeFile(join(stub, "runtime-up.out"), "{}");
  await writeFile(
    join(stub, "project-plan.out"),
    JSON.stringify({
      plan_id: "f".repeat(64),
      start_refusals: [],
      plan: {
        namespace: "c".repeat(64),
        compose_sha256: createHash("sha256")
          .update(JSON.stringify(COMPOSE))
          .digest("hex"),
        enrollment_compatible: true,
        services: { web: { active: true } },
      },
    })
  );
  return {
    root,
    project,
    projectDir,
    composeFile,
    binary,
    nativeHome,
    xdg,
    calls: async () =>
      (await readFile(join(stub, "calls"), "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ").slice(2, 4).join(" ")),
  };
}

for (const mode of ["foreground", "detached", "json"] as const) {
  const detached = mode !== "foreground";
  test(
    `native ${mode} up reports forwarded shell names and prints no value`,
    async () => {
      const f = await fixture();
      const child = Bun.spawn(
        [
          process.execPath,
          entrypoint,
          "--path",
          f.project,
          "up",
          ...(mode === "json" ? ["--json"] : detached ? ["-d"] : []),
        ],
        {
          cwd: f.root,
          env: privateCliEnv({
            root: f.root,
            env: {
              ...f.xdg,
              HACK_RUNTIME_BACKEND: "native",
              HACK_NATIVE_BINARY: f.binary,
              HACK_NATIVE_HOME: f.nativeHome,
              HACK_NATIVE_SHARED_SOURCE: "1",
              HACK_NO_INTERACTIVE: "1",
              HACK_LOGGER: "console",
              FIXTURE_API_KEY: PRIVATE,
              PASSED: `${PRIVATE}-passed`,
              UNREFERENCED_PRIVATE: `${PRIVATE}-unreferenced`,
            },
          }),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: SPAWN_TIMEOUT_MS - 5000,
        }
      );
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      const output = stdout + stderr;
      if (mode === "json") {
        expect(JSON.parse(stdout).ok).toBe(false);
      }
      // The unset variable is named once; the service still starts with it empty.
      if (!detached) {
        expect(
          output.split(
            "Service web: REGION is empty because FIXTURE_REGION is not set in the interpolation context.\n"
          )
        ).toHaveLength(2);
      }
      expect(
        stderr.split("Forwarding shell variables: FIXTURE_API_KEY, PASSED.\n")
      ).toHaveLength(2);
      expect(output).not.toContain("UNREFERENCED_PRIVATE");
      // No value reaches the terminal.
      expect(output).not.toContain(PRIVATE);
      // The project passed the CLI's admission: the stub runtime was asked to start.
      expect(output).not.toContain("E_NATIVE_PROJECT_UNSUPPORTED");
      expect(await f.calls()).toContain("project plan");
      for (const directory of [f.nativeHome, ...Object.values(f.xdg)]) {
        for (const path of await regularFiles(directory)) {
          expect(await readFile(path, "utf8")).not.toContain(PRIVATE);
        }
      }
      expect(
        await readFile(join(f.root, "stub", "calls"), "utf8")
      ).not.toContain(PRIVATE);
    },
    SPAWN_TIMEOUT_MS
  );
}

test("shell values travel only in the private stdin payload, never in the public document", async () => {
  const f = await fixture();
  const input = await prepareNativeProjectInput({
    projectRoot: f.project,
    projectDir: f.projectDir,
    composeFile: f.composeFile,
    env: { FIXTURE_API_KEY: PRIVATE, PASSED: `${PRIVATE}-passed` },
  });
  expect(input.normalizedComposeJson).not.toContain(PRIVATE);
  const selection = {
    planId: "f".repeat(64),
    reviewedPlan: { services: { web: { active: true } } },
    run: "a".repeat(32),
  };
  // Until native start or restart merges them, shell values are delivered to
  // nothing: a command that only prepares input (exec, the stale-env check)
  // sends no private payload for them.
  expect(nativeEnvironmentDelivery({ input, ...selection })).toEqual({
    flags: [],
  });
  const delivery = nativeEnvironmentDelivery({
    input: mergeNativeShellEnvironment(input),
    ...selection,
  });
  expect(delivery.flags).toEqual(["--environment-stdin"]);
  const payload = JSON.parse(delivery.payload?.toString("utf8") ?? "{}") as {
    services: Record<string, Record<string, string>>;
  };
  expect(payload.services).toEqual({
    web: {
      API_KEY: PRIVATE,
      // Compose substitutes an empty string for an unset variable.
      REGION: "",
      PASSED: `${PRIVATE}-passed`,
    },
  });
});

test("a variable named like an Object.prototype property is an ordinary variable", async () => {
  const f = await fixture();
  await writeFile(
    f.composeFile,
    JSON.stringify({
      services: {
        web: {
          image: IMAGE,
          environment: Object.fromEntries([
            ["__proto__", reference("FIXTURE_SET")],
            ["constructor", null],
            ["PLAIN", reference("toString")],
          ]),
        },
      },
    })
  );
  const resolution = await prepareNativeProjectInput({
    ...f,
    projectRoot: f.project,
    env: { FIXTURE_SET: PRIVATE },
  });
  expect(Object.entries(resolution.shellEnvironment?.web ?? {})).toEqual([
    ["__proto__", PRIVATE],
    // Not set in this shell; never the inherited function.
    ["PLAIN", ""],
  ]);
  expect(
    Object.keys(
      JSON.parse(resolution.normalizedComposeJson).services.web.environment
    )
  ).toEqual(["__proto__", "PLAIN"]);
  expect(
    JSON.parse(resolution.normalizedComposeJson).services.web[
      "x-hack-unset-environment"
    ]
  ).toEqual(["constructor"]);
});

async function regularFiles(directory: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    }
  );
  for (const entry of entries) {
    expect(entry.isSymbolicLink()).toBe(false);
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await regularFiles(path)));
    } else if (entry.isFile()) {
      result.push(path);
    }
  }
  return result;
}

test("only source names referenced by Compose are read and reported, never the ambient environment", async () => {
  const caller = Object.defineProperties(
    { REFERENCED: PRIVATE },
    {
      UNREFERENCED: {
        enumerable: true,
        get() {
          throw new Error("ambient variable must never be read");
        },
      },
    }
  );
  const f = await fixture();
  await writeFile(
    f.composeFile,
    JSON.stringify({
      services: {
        web: {
          image: IMAGE,
          environment: {
            API_KEY: reference("REFERENCED"),
            COPY: reference("REFERENCED"),
          },
        },
      },
    })
  );
  const resolved = await prepareNativeProjectInput({
    ...f,
    projectRoot: f.project,
    env: caller,
  });
  expect(resolved.shellEnvironment?.web).toEqual({
    API_KEY: PRIVATE,
    COPY: PRIVATE,
  });
  expect(resolved.forwardedShellVariables?.web).toEqual(["REFERENCED"]);
  expect(resolved.normalizedComposeJson).not.toContain(PRIVATE);
});
