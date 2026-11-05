import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitNativeProjectBuild,
  admitNativeProjectBuilds,
  buildNativeProjectImages,
  invokeNativeBuild,
  NATIVE_BUILDS_DISABLED_REFUSAL,
  type NativeBuildRequest,
  nativeBuildsEnabled,
} from "../src/backends/native-project-builds.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";
import { HackCliError } from "../src/lib/cli-result.ts";

const IMAGE = `sha256:${"a".repeat(64)}`;
const RETAINED = `sha256:${"b".repeat(64)}`;
const KEY = "c".repeat(64);
const VALUE = "synthetic-literal-value";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "hack-native-builds-"));
  roots.push(path);
  return path;
}

function admit(
  service: Record<string, unknown>,
  composeFile = "/p/.hack/compose.yaml"
) {
  return admitNativeProjectBuild({ service, projectRoot: "/p", composeFile });
}

test("admitted build forms follow Compose paths and literal arguments", () => {
  expect(admit({ build: ".." })).toEqual({
    context: ".",
    dockerfile: "Dockerfile",
    target: null,
    args: {},
  });
  expect(
    admit({
      build: {
        context: "../app",
        dockerfile: "docker/Dockerfile.dev",
        target: "base",
        args: { VERSION: "1.2", RETRIES: 3 },
      },
    })
  ).toEqual({
    context: "app",
    dockerfile: "docker/Dockerfile.dev",
    target: "base",
    args: { VERSION: "1.2", RETRIES: "3" },
  });
  expect(admit({ build: { args: ["A=1", "B=x=y"] } })?.args).toEqual({
    A: "1",
    B: "x=y",
  });
  expect(admit({ image: "busybox" })).toBeUndefined();
});

test.each([
  [{ image: "busybox", build: "." }, "both image and build"],
  [{ build: { context: ".", ssh: ["default"] } }, "only build context"],
  [
    { build: { context: ".", platforms: ["linux/arm64"] } },
    "only build context",
  ],
  [{ build: { args: { A: "${HOST_VALUE}" } } }, "interpolation"],
  [{ build: { args: { A: null } } }, "interpolation and null"],
  [{ build: { args: ["INHERITED"] } }, "KEY=VALUE"],
  [{ build: { args: { "bad-name": "x" } } }, "unique identifiers"],
  [{ build: "$CONTEXT" }, "interpolation"],
  [{ build: "../.." }, "inside the project"],
  [{ build: "https://example.invalid/repo.git" }, "remote build contexts"],
  [
    { build: { dockerfile: "/etc/Dockerfile" } },
    "relative to the build context",
  ],
  [{ build: { target: "-x" } }, "stage name"],
  [{ build: 7 }, "context path or a mapping"],
])("unsupported build %j refuses before any effect", (service, text) => {
  const error = (() => {
    try {
      admit(service);
    } catch (caught: unknown) {
      return caught;
    }
  })();
  expect(error).toBeInstanceOf(HackCliError);
  expect(error).toMatchObject({ code: "E_NATIVE_PROJECT_UNSUPPORTED" });
  expect(String((error as Error).message)).toContain(text);
  expect(String((error as Error).message)).not.toContain("HOST_VALUE");
});

test("builds refuse unless explicitly enabled, and projects without builds are unaffected", () => {
  const services = { web: { build: "." }, db: { image: "postgres:17" } };
  expect(() =>
    admitNativeProjectBuilds({
      services,
      projectRoot: "/p",
      composeFile: "/p/compose.yaml",
      enabled: false,
    })
  ).toThrow(NATIVE_BUILDS_DISABLED_REFUSAL);
  expect(
    admitNativeProjectBuilds({
      services: { db: { image: "postgres:17" } },
      projectRoot: "/p",
      composeFile: "/p/compose.yaml",
      enabled: false,
    }).size
  ).toBe(0);
  expect([
    ...admitNativeProjectBuilds({
      services,
      projectRoot: "/p",
      composeFile: "/p/compose.yaml",
      enabled: true,
    }).keys(),
  ]).toEqual(["web"]);
  expect(nativeBuildsEnabled({ HACK_NATIVE_BUILDS: "1" })).toBe(true);
  expect(nativeBuildsEnabled({ HACK_NATIVE_BUILDS: "true" })).toBe(false);
});

const runtime = {
  binary: "/unused/hack-native",
  home: "/unused/home",
} as never;
const request = (
  args: Record<string, string> = { A: VALUE }
): NativeBuildRequest => ({
  context: "app",
  dockerfile: "Dockerfile",
  target: null,
  args,
});

test("identical builds run once, pin every service and keep the request private", async () => {
  const project = await root();
  const specs: Record<string, Record<string, unknown>> = {
    one: { build: "app" },
    two: { build: "app" },
    other: { build: { context: "app", target: "dev" } },
  };
  const seen: { body: Record<string, unknown>; mode: number; path: string }[] =
    [];
  await buildNativeProjectImages({
    runtime,
    projectRoot: project,
    branch: "feature",
    builds: new Map([
      ["one", request()],
      ["two", request()],
      ["other", { ...request(), target: "dev" }],
    ]),
    specs,
    retainedImages: new Map(),
    restore: false,
    rebuild: false,
    signal: new AbortController().signal,
    invoke: async ({ requestFile }) => {
      seen.push({
        body: JSON.parse(await readFile(requestFile, "utf8")),
        mode: (await stat(requestFile)).mode & 0o777,
        path: requestFile,
      });
      return { imageId: IMAGE, buildKey: KEY, reused: false };
    },
  });
  expect(seen).toHaveLength(2);
  expect(seen[0]?.mode).toBe(0o600);
  expect(seen[0]?.body).toMatchObject({
    version: 1,
    branch: "feature",
    context: "app",
    policy: "missing",
    args: { A: VALUE },
  });
  expect(seen[1]?.body.target).toBe("dev");
  for (const { path } of seen) {
    expect(await Bun.file(path).exists()).toBe(false);
  }
  for (const spec of Object.values(specs)) {
    expect(spec).toEqual({ image: IMAGE });
  }
});

test("retained images win, and restore never builds a missing one", async () => {
  const project = await root();
  const calls: string[] = [];
  const invoke = async () => {
    calls.push("build");
    return { imageId: IMAGE, buildKey: KEY, reused: true };
  };
  const base = {
    runtime,
    projectRoot: project,
    branch: null,
    rebuild: false,
    signal: new AbortController().signal,
    invoke,
  };
  const specs = { web: { build: "app" } as Record<string, unknown> };
  await buildNativeProjectImages({
    ...base,
    builds: new Map([["web", request()]]),
    specs,
    retainedImages: new Map([["web", RETAINED]]),
    restore: true,
  });
  expect(specs.web).toEqual({ image: RETAINED });
  expect(calls).toEqual([]);

  const missing = await buildNativeProjectImages({
    ...base,
    builds: new Map([["worker", request()]]),
    specs: { worker: { build: "app" } },
    retainedImages: new Map([["web", RETAINED]]),
    restore: true,
  }).catch((error: unknown) => error);
  expect(String(missing)).toContain("Nothing was built");
  expect(calls).toEqual([]);

  // A retained run whose configuration changed selects no retained images and builds.
  await buildNativeProjectImages({
    ...base,
    builds: new Map([["worker", request()]]),
    specs: { worker: { build: "app" } },
    retainedImages: new Map(),
    restore: true,
  });
  expect(calls).toEqual(["build"]);
});

test("an explicit rebuild asks the runtime to build again", async () => {
  const project = await root();
  let policy: unknown;
  await buildNativeProjectImages({
    runtime,
    projectRoot: project,
    branch: null,
    builds: new Map([["web", request()]]),
    specs: { web: { build: "app" } },
    retainedImages: new Map(),
    restore: false,
    rebuild: true,
    signal: new AbortController().signal,
    invoke: async ({ requestFile }) => {
      policy = JSON.parse(await readFile(requestFile, "utf8")).policy;
      return { imageId: IMAGE, buildKey: KEY, reused: false };
    },
  });
  expect(policy).toBe("rebuild");
});

async function fakeRuntime(
  script: string
): Promise<{ binary: string; home: string }> {
  const directory = await root();
  const binary = join(directory, "hack-native");
  await writeFile(binary, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
  await chmod(binary, 0o700);
  const home = join(directory, "home");
  await mkdir(home);
  return { binary, home };
}

test("build output streams through while the runtime's closed error is returned", async () => {
  const fake = await fakeRuntime(
    `printf 'step 1\\nstep 2\\n' >&2\nprintf '{"code":"native_build_failed","message":"The image build failed."}\\n' >&2\nexit 2`
  );
  const written: string[] = [];
  const error = await invokeNativeBuild({
    runtime: fake as never,
    cwd: fake.home,
    requestFile: join(fake.home, "request.json"),
    write: (text) => written.push(text),
  }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(NativeRuntimeRequestError);
  expect(error).toMatchObject({ nativeCode: "native_build_failed" });
  expect(written.join("")).toBe("step 1\nstep 2\n");

  const ok = await fakeRuntime(
    `printf 'progress\\n' >&2\nprintf '{"image_id":"${IMAGE}","build_key":"${KEY}","tag":"t","reused":false,"base_pins":{}}'`
  );
  const built = await invokeNativeBuild({
    runtime: ok as never,
    cwd: ok.home,
    requestFile: join(ok.home, "request.json"),
    write: () => undefined,
  });
  expect(built).toEqual({ imageId: IMAGE, buildKey: KEY, reused: false });
});

test("cancellation sends SIGTERM so the runtime can stop its build client", async () => {
  const fake = await fakeRuntime(
    `trap 'printf terminated > "$0.signal"; exit 143' TERM\nprintf 'started\\n' >&2\nwhile :; do sleep 0.05; done`
  );
  const controller = new AbortController();
  const pending = invokeNativeBuild({
    runtime: fake as never,
    cwd: fake.home,
    requestFile: join(fake.home, "request.json"),
    signal: controller.signal,
    write: (text) => {
      if (text.includes("started")) {
        controller.abort();
      }
    },
  }).catch((caught: unknown) => caught);
  const error = await pending;
  expect(String(error)).toContain("canceled during an image build");
  expect(await readFile(`${fake.binary}.signal`, "utf8")).toBe("terminated");
});
