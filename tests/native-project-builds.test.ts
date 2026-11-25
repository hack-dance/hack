import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  admitNativeProjectBuild,
  admitNativeProjectBuilds,
  buildNativeProjectImages,
  invokeNativeBuild,
  type NativeBuildRequest,
  nativeBuildBases,
  nativeBuildIdentity,
  nativeBuildsDisabledRefusal,
  nativeBuildsEnabled,
  nativeServiceActive,
  pinVerifiedNativeBuilds,
  refuseEmulatedBuilds,
  refuseManagedSecretBuildArguments,
  resolveNativeRestartBuilds,
} from "../src/backends/native-project-builds.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import { nativeBuilderRemedy } from "../src/lib/native-image-builder.ts";

const IMAGE = `sha256:${"a".repeat(64)}`;
const RETAINED = `sha256:${"b".repeat(64)}`;
const REBUILT = `sha256:${"d".repeat(64)}`;
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
  return admitNativeProjectBuild({
    name: "app",
    service,
    projectRoot: "/p",
    composeFile,
  });
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

test("an argument named __proto__ survives admission and serialization", () => {
  const requested = '{"__proto__":"requested-value"}';
  for (const args of [["__proto__=requested-value"], JSON.parse(requested)]) {
    const request = admit({ build: { args } });
    expect(Object.keys(request?.args ?? {})).toEqual(["__proto__"]);
    expect(JSON.stringify(request?.args)).toBe(requested);
  }
  // Declarations that differ only in that argument stay distinct builds.
  const builds = admitNativeProjectBuilds({
    services: {
      plain: { build: { context: "..", args: ["A=1"] } },
      proto: {
        build: { context: "..", args: ["A=1", "__proto__=requested-value"] },
      },
    },
    projectRoot: "/p",
    composeFile: "/p/.hack/compose.yaml",
    enabled: true,
  });
  expect(JSON.stringify(builds.get("proto")?.args)).toBe(
    '{"A":"1","__proto__":"requested-value"}'
  );
  expect(JSON.stringify(builds.get("plain")?.args)).toBe('{"A":"1"}');
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
  const message = String((error as Error).message);
  expect(message).toContain(text);
  // HACK-1927: every admission refusal names the service it is about.
  expect(message).toStartWith(
    "Native foreground up cannot build service app: "
  );
  expect(message).not.toContain("HOST_VALUE");
  expect(message).not.toContain("HACK_RUNTIME_BACKEND");
});

test("admission names a known unsupported build field, never an unknown key", () => {
  const message = (build: Record<string, unknown>) => {
    try {
      admit({ build: { context: "..", ...build } });
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("expected a refusal");
  };
  expect(message({ additional_contexts: { extra: "synthetic-canary" } })).toBe(
    "Native foreground up cannot build service app: build.additional_contexts is not supported by native builds (native builds read one context directory); only build context, dockerfile, target and literal args are supported. Values were omitted; no hook, VM or build was started."
  );
  expect(message({ secrets: ["synthetic-canary"] })).toContain(
    "build.secrets is not supported by native builds; only build context"
  );
  const unknown = message({ "private-key-name": "synthetic-canary" });
  expect(unknown).toContain(
    "cannot build service app: only build context, dockerfile, target and literal args are supported."
  );
  expect(unknown).not.toContain("private-key-name");
  expect(unknown).not.toContain("synthetic-canary");
});

test("builds refuse while turned off, and projects without builds are unaffected", () => {
  const services = { web: { build: "." }, db: { image: "postgres:17" } };
  expect(() =>
    admitNativeProjectBuilds({
      services,
      projectRoot: "/p",
      composeFile: "/p/compose.yaml",
      enabled: false,
    })
  ).toThrow(nativeBuildsDisabledRefusal("web"));
  expect(nativeBuildsDisabledRefusal("web")).toContain(
    "cannot build service web: "
  );
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
});

test("native builds are on by default and HACK_NATIVE_BUILDS=0 is the only off switch", () => {
  // HACK-2532: a normal project builds at least one image, so native builds
  // cannot be an opt-in while native is the default backend.
  expect(nativeBuildsEnabled({})).toBe(true);
  expect(nativeBuildsEnabled({ HACK_NATIVE_BUILDS: undefined })).toBe(true);
  expect(nativeBuildsEnabled({ HACK_NATIVE_BUILDS: "" })).toBe(true);
  // The earlier opt-in value keeps working.
  expect(nativeBuildsEnabled({ HACK_NATIVE_BUILDS: "1" })).toBe(true);
  expect(nativeBuildsEnabled({ HACK_NATIVE_BUILDS: "true" })).toBe(true);
  expect(nativeBuildsEnabled({ HACK_NATIVE_BUILDS: "0" })).toBe(false);
  expect(nativeBuildsDisabledRefusal("web")).toContain(
    "HACK_NATIVE_BUILDS=0 turns native builds off; unset HACK_NATIVE_BUILDS"
  );
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
    profiles: [],
    builds: new Map([
      ["one", request()],
      ["two", request()],
      ["other", { ...request(), target: "dev" }],
    ]),
    specs,
    imageTagMode: "offline",
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
    image_tag_mode: "offline",
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

test("every up asks the runtime for each build, a restore too (HACK-2533)", async () => {
  const project = await root();
  const keys: string[] = [];
  // The runtime reuses an image only under an unchanged build key: the fake
  // answers with the image for whatever key the request's target stands for.
  const invoke = async ({ requestFile }: { requestFile: string }) => {
    const target = JSON.parse(await readFile(requestFile, "utf8")).target;
    keys.push(target ?? "same");
    return target === "changed"
      ? { imageId: REBUILT, buildKey: KEY, reused: false }
      : { imageId: RETAINED, buildKey: KEY, reused: true };
  };
  const base = {
    runtime,
    projectRoot: project,
    branch: null,
    profiles: [],
    rebuild: false,
    signal: new AbortController().signal,
    invoke,
  };
  const unchanged = { web: { build: "app" } as Record<string, unknown> };
  const pinned = await buildNativeProjectImages({
    ...base,
    builds: new Map([["web", request()]]),
    specs: unchanged,
  });
  expect([...pinned]).toEqual(["web"]);
  expect(unchanged.web).toEqual({ image: RETAINED });

  const changed = { web: { build: "app" } as Record<string, unknown> };
  await buildNativeProjectImages({
    ...base,
    builds: new Map([["web", { ...request(), target: "changed" }]]),
    specs: changed,
  });
  expect(changed.web).toEqual({ image: REBUILT });
  expect(keys).toEqual(["same", "changed"]);
});

test("restart resolves its builds before stopping: a rebuilt image is what it runs", async () => {
  const project = await root();
  let calls = 0;
  const base = {
    runtime,
    projectRoot: project,
    branch: null,
    profiles: [],
    managedSecretValues: [],
  };
  const specs = {
    web: { build: "app" } as Record<string, unknown>,
    tools: { build: "app", profiles: ["tools"] } as Record<string, unknown>,
  };
  const builds = new Map([
    ["web", request()],
    ["tools", request()],
  ]);
  const resolved = await resolveNativeRestartBuilds({
    ...base,
    builds,
    specs,
    images: new Map([["web", RETAINED]]),
    rebuild: false,
    signal: new AbortController().signal,
    invoke: async () => {
      calls += 1;
      return { imageId: REBUILT, buildKey: KEY, reused: false };
    },
  });
  // Only the running, active service is resolved; the caller's specs are untouched.
  expect([...resolved]).toEqual([
    ["web", { imageId: REBUILT, identity: nativeBuildIdentity(request()) }],
  ]);
  expect(calls).toBe(1);
  expect(specs.web).toEqual({ build: "app" });
});

test("a restart's replacement start pins only images resolved for the same declarations", () => {
  const verified = new Map([
    ["web", { imageId: REBUILT, identity: nativeBuildIdentity(request()) }],
  ]);
  const specs = {
    web: { build: "app" } as Record<string, unknown>,
    tools: { build: "app", profiles: ["tools"] } as Record<string, unknown>,
  };
  const remaining = pinVerifiedNativeBuilds({
    builds: new Map([
      ["web", request()],
      ["tools", request()],
    ]),
    specs,
    profiles: [],
    verified,
  });
  expect(specs.web).toEqual({ image: REBUILT });
  // The inactive service is neither pinned nor built.
  expect([...remaining.keys()]).toEqual(["tools"]);
  // A declaration changed, or a build service added, after preflight refuses.
  for (const builds of [
    new Map([["web", { ...request(), target: "other" }]]),
    new Map([
      ["web", request()],
      ["worker", request()],
    ]),
  ]) {
    expect(() =>
      pinVerifiedNativeBuilds({
        builds,
        specs: { web: { build: "app" }, worker: { build: "app" } },
        profiles: [],
        verified,
      })
    ).toThrow("changed during the restart");
  }
  // Without a restart selection every build still goes to the runtime.
  const all = new Map([["web", request()]]);
  expect(
    pinVerifiedNativeBuilds({
      builds: all,
      specs: {},
      profiles: [],
      verified: undefined,
    })
  ).toBe(all);
});

test("restart honours a forced rebuild as up does", async () => {
  const project = await root();
  const policies: unknown[] = [];
  for (const rebuild of [false, true]) {
    await resolveNativeRestartBuilds({
      runtime,
      projectRoot: project,
      branch: null,
      profiles: [],
      builds: new Map([["web", request()]]),
      specs: { web: { build: "app" } },
      images: new Map([["web", RETAINED]]),
      managedSecretValues: [],
      rebuild,
      signal: new AbortController().signal,
      invoke: async ({ requestFile }) => {
        policies.push(JSON.parse(await readFile(requestFile, "utf8")).policy);
        return { imageId: REBUILT, buildKey: KEY, reused: false };
      },
    });
  }
  expect(policies).toEqual(["missing", "rebuild"]);
});

test("restart refuses a managed secret build argument before any build runs", async () => {
  const project = await root();
  let calls = 0;
  const refused = await resolveNativeRestartBuilds({
    runtime,
    projectRoot: project,
    branch: null,
    profiles: [],
    builds: new Map([["web", request({ TOKEN: VALUE })]]),
    specs: { web: { build: "app" } },
    images: new Map([["web", RETAINED]]),
    managedSecretValues: [VALUE],
    rebuild: false,
    signal: new AbortController().signal,
    invoke: async () => {
      calls += 1;
      return { imageId: RETAINED, buildKey: KEY, reused: true };
    },
  }).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(Error);
  expect(String(refused)).not.toContain(VALUE);
  expect(calls).toBe(0);
});

test("a restart's stop request reaches its build and no later build starts", async () => {
  const project = await root();
  const controller = new AbortController();
  const seen: boolean[] = [];
  const result = await resolveNativeRestartBuilds({
    runtime,
    projectRoot: project,
    branch: null,
    profiles: [],
    builds: new Map([
      ["web", request()],
      ["worker", { ...request(), target: "worker" }],
    ]),
    specs: { web: { build: "app" }, worker: { build: "app" } },
    images: new Map([
      ["web", RETAINED],
      ["worker", RETAINED],
    ]),
    managedSecretValues: [],
    rebuild: false,
    signal: controller.signal,
    invoke: async ({ signal }) => {
      seen.push(signal?.aborted ?? false);
      controller.abort();
      return { imageId: RETAINED, buildKey: KEY, reused: true };
    },
  }).catch((error: unknown) => error);
  expect(seen).toEqual([false]);
  expect(String(result)).toContain("canceled");
});

test("only build services in the selected profiles are built and pinned, as with Compose up", async () => {
  const project = await root();
  const built: string[] = [];
  const invoke = async ({ requestFile }: { requestFile: string }) => {
    built.push(JSON.parse(await readFile(requestFile, "utf8")).target ?? "");
    return { imageId: IMAGE, buildKey: KEY, reused: false };
  };
  const declared = () => ({
    web: { build: "app" } as Record<string, unknown>,
    tools: { build: "app", profiles: ["tools"] } as Record<string, unknown>,
  });
  const builds = new Map([
    ["web", request()],
    ["tools", { ...request(), target: "tools" }],
  ]);
  const base = {
    runtime,
    projectRoot: project,
    branch: null,
    builds,
    rebuild: false,
    signal: new AbortController().signal,
    invoke,
  };
  const specs = declared();
  await buildNativeProjectImages({
    ...base,
    profiles: [],
    specs,
  });
  expect(built).toEqual([""]);
  expect(specs.web).toEqual({ image: IMAGE });
  // The inactive service keeps its declaration: no image, no build, no pin.
  expect(specs.tools).toEqual({ build: "app", profiles: ["tools"] });

  // Restoring that run asks again only for the active service.
  built.length = 0;
  const restored = declared();
  await buildNativeProjectImages({
    ...base,
    profiles: [],
    specs: restored,
  });
  expect(built).toEqual([""]);
  expect(restored.web).toEqual({ image: IMAGE });
  expect(restored.tools).toEqual({ build: "app", profiles: ["tools"] });

  // Selecting the profile later builds that service then.
  const selected = declared();
  await buildNativeProjectImages({
    ...base,
    profiles: ["tools"],
    specs: selected,
  });
  expect(built).toEqual(["", "", "tools"]);
  expect(selected.tools).toEqual({ image: IMAGE, profiles: ["tools"] });
});

test("a build service cannot select amd64 emulation; prefer-native is accepted", () => {
  const builds = new Map([["web", request()]]);
  let refusal: unknown;
  try {
    refuseEmulatedBuilds({ builds, amd64Emulation: { web: "amd64" } });
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(HackCliError);
  expect((refusal as HackCliError).code).toBe("E_NATIVE_PROJECT_UNSUPPORTED");
  expect(String(refusal)).toContain("linux/arm64 only");
  expect(String(refusal)).toContain("service web");
  refuseEmulatedBuilds({ builds, amd64Emulation: { web: "prefer-native" } });
  refuseEmulatedBuilds({ builds, amd64Emulation: { other: "amd64" } });
  refuseEmulatedBuilds({ builds });
});

test("service activity follows Compose profiles", () => {
  expect(nativeServiceActive({}, [])).toBe(true);
  expect(nativeServiceActive({ profiles: ["a"] }, [])).toBe(false);
  expect(nativeServiceActive({ profiles: ["a", "b"] }, ["b"])).toBe(true);
  expect(nativeServiceActive({ profiles: [] }, [])).toBe(true);
  expect(nativeServiceActive({ profiles: "a" }, [])).toBe(true);
});

test("a build arg equal to a managed secret value refuses without showing it", () => {
  const secret = "managed-secret-value-not-shown";
  const builds = new Map([
    ["web", request({ TOKEN: secret, MODE: "production" })],
  ]);
  let refusal: unknown;
  try {
    refuseManagedSecretBuildArguments({
      builds,
      managedSecretValues: ["other", secret],
    });
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(HackCliError);
  const error = refusal as HackCliError;
  expect(error.code).toBe("E_NATIVE_PROJECT_UNSUPPORTED");
  // HACK-1925: the refusal names the service and the argument, never the value,
  // and does not point at the Compose backend, which would bake it into history.
  expect(error.message).toContain(
    "cannot build service web: build arg TOKEN equals a hack env secret value"
  );
  expect(error.message).not.toContain(secret);
  expect(error.message).not.toContain("HACK_RUNTIME_BACKEND");
  expect(error.message).not.toContain("Compose backend");
  // Values that are not managed secrets pass; so does any build with no secrets.
  refuseManagedSecretBuildArguments({
    builds: new Map([["web", request({ MODE: "production" })]]),
    managedSecretValues: [secret],
  });
  refuseManagedSecretBuildArguments({ builds, managedSecretValues: [] });
});

test("an explicit rebuild asks the runtime to build again", async () => {
  const project = await root();
  let policy: unknown;
  await buildNativeProjectImages({
    runtime,
    projectRoot: project,
    branch: null,
    profiles: [],
    builds: new Map([["web", request()]]),
    specs: { web: { build: "app" } },
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
  expect(built).toEqual({
    imageId: IMAGE,
    buildKey: KEY,
    reused: false,
  });
});

test("a build base registry refusal keeps the normalized reference and closed cause", async () => {
  const reference = "docker.io/library/python:3.12-alpine";
  const fake = await fakeRuntime(
    `printf '{"code":"registry_image","message":"discarded private detail","build_base_reference":"${reference}","cause_code":"registry_http_429"}\\n' >&2\nexit 1`
  );
  const error = await invokeNativeBuild({
    runtime: fake as never,
    cwd: fake.home,
    requestFile: join(fake.home, "request.json"),
    write: () => undefined,
  }).catch((caught: unknown) => caught);
  expect(error).toMatchObject({
    reference,
    nativeCode: "registry_image",
    nativeCauseCode: "registry_http_429",
    message: expect.stringContaining("registry rate limit reached"),
  });
  expect(String(error)).not.toContain("discarded private detail");
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

test("runtime build refusals name the services and the build source policy", async () => {
  const project = await root();
  const policy =
    "Dockerfile line 1: build images must be public Docker Hub references.";
  const fail = (nativeCode: string, message: string) => async () => {
    throw new NativeRuntimeRequestError({ message, nativeCode });
  };
  const run = async (invoke: () => Promise<never>) =>
    await buildNativeProjectImages({
      runtime,
      projectRoot: project,
      branch: null,
      profiles: [],
      // Identical declarations build once, so one refusal covers both services.
      builds: new Map([
        ["web", request()],
        ["worker", request()],
      ]),
      specs: { web: { build: "app" }, worker: { build: "app" } },
      rebuild: false,
      signal: new AbortController().signal,
      invoke,
    }).catch((caught: unknown) => caught);

  const refused = await run(fail("native_build_base_image", policy));
  expect(refused).toBeInstanceOf(NativeRuntimeRequestError);
  expect(refused).toMatchObject({ nativeCode: "native_build_base_image" });
  const message = (refused as Error).message;
  expect(message).toStartWith(
    "Native foreground up cannot build services web and worker: the native build source policy refused it. "
  );
  expect(message).toContain(policy);
  expect(message).toContain("Use public Docker Hub images");
  expect(message).not.toContain(VALUE);

  // A failure that is not a policy refusal names the services and keeps its message.
  const failed = await run(
    fail("native_build_failed", "The image build failed.")
  );
  expect(failed).toMatchObject({ nativeCode: "native_build_failed" });
  expect((failed as Error).message).toBe(
    "Native foreground up could not build services web and worker: The image build failed."
  );
  expect((failed as Error).message).not.toContain("source policy");

  // An inherited property name is not a policy code.
  const odd = await run(fail("constructor", "Unexpected failure."));
  expect((odd as Error).message).toBe(
    "Native foreground up could not build services web and worker: Unexpected failure."
  );
});

test("a native home without the image builder says so and how to add it", async () => {
  const project = await root();
  // The runtime's own reply for a home that never prepared the builder, as
  // `runtime build-image` prints it: one JSON line on stderr and a failure exit.
  const fake = await fakeRuntime(
    `printf 'resolving base images\\n' >&2\nprintf '{"code":"builder_not_prepared","message":"The image builder is not installed in this native home, so no image was built.","message_fixed":true}\\n' >&2\nexit 1`
  );
  const written: string[] = [];
  const refused = await buildNativeProjectImages({
    runtime: fake as never,
    projectRoot: project,
    branch: null,
    profiles: [],
    builds: new Map([
      ["web", request()],
      ["worker", request()],
    ]),
    specs: { web: { build: "app" }, worker: { build: "app" } },
    rebuild: false,
    signal: new AbortController().signal,
    invoke: (opts) =>
      invokeNativeBuild({ ...opts, write: (text) => written.push(text) }),
  }).catch((caught: unknown) => caught);
  expect(refused).toBeInstanceOf(NativeRuntimeRequestError);
  expect(refused).toMatchObject({ nativeCode: "builder_not_prepared" });
  const message = (refused as Error).message;
  expect(message).toBe(
    `Native foreground up cannot build services web and worker: the image builder is not installed in this native home. ${nativeBuilderRemedy()} No image was built.`
  );
  // The command for a stable install; other installs name their own launcher.
  expect(message).toContain(
    "Run hack native setup --accept-downloads to add it; offline, add --builder <pinned builder file> to the offline setup inputs."
  );
  expect(
    nativeBuilderRemedy({
      launcher: { kind: "bundle", command: "/opt/bundle/hack-v5" },
    })
  ).toStartWith("Run /opt/bundle/hack-v5 native setup --accept-downloads ");
  // Neither the missing file's OS error nor a build-failure wording reaches the user.
  expect(message).not.toContain("os error");
  expect(message).not.toContain("No such file");
  expect(message).not.toContain("could not build");
  expect(message).not.toContain(VALUE);
  expect(written.join("")).toBe("resolving base images\n");
});

test("build base scans deduplicate references and remove the private request", async () => {
  const projectRoot = await root();
  const files: string[] = [];
  const alpine = "docker.io/library/alpine:3.20";
  expect(
    await nativeBuildBases({
      projectRoot,
      runtime,
      builds: new Map([
        ["one", request()],
        ["two", request({})],
      ]),
      invoke: async ({ args }) => {
        const path = args[3];
        if (!path) {
          throw new Error("Expected a build request path");
        }
        files.push(path);
        expect(args.slice(4)).toEqual(["--bases", "--json"]);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        return files.length === 1
          ? [alpine]
          : [alpine, "docker.io/library/busybox:latest"];
      },
    })
  ).toEqual([alpine, "docker.io/library/busybox:latest"]);
  expect(files).toHaveLength(2);
  expect(await Bun.file(files[0] ?? "").exists()).toBe(false);
});

test("later builds receive command base pins and each fallback notice is reported once", async () => {
  const projectRoot = await root();
  const reference = "docker.io/library/alpine:3.20";
  const pin = `docker.io/library/alpine@${IMAGE}`;
  const notice = "Registry unavailable, using the loaded build base.";
  const notices: string[] = [];
  let calls = 0;
  await buildNativeProjectImages({
    runtime,
    projectRoot,
    branch: null,
    profiles: [],
    builds: new Map([
      ["one", request()],
      ["two", request({})],
    ]),
    specs: { one: { build: "app" }, two: { build: "app" } },
    rebuild: false,
    imageTagMode: "refresh",
    signal: new AbortController().signal,
    onNotice: (line) => notices.push(line),
    invoke: async ({ requestFile }) => {
      const body = JSON.parse(await readFile(requestFile, "utf8"));
      expect(body.image_tag_mode).toBe("refresh");
      expect(body.command_base_pins).toEqual(
        calls === 0 ? undefined : { [reference]: pin }
      );
      calls += 1;
      return {
        imageId: IMAGE,
        buildKey: KEY,
        reused: true,
        baseSelections: { [reference]: pin },
        baseFallbacks: [notice],
      };
    },
  });
  expect(calls).toBe(2);
  expect(notices).toEqual([notice]);
});

test("build output decodes lock progress and verified fallback notices", async () => {
  const reference = "docker.io/library/alpine:3.20";
  const fake = await fakeRuntime(
    `printf 'hack.image-wait:begin ${reference}\\nhack.image-wait:end ${reference}\\n' >&2
     printf '{"image_id":"${IMAGE}","build_key":"${KEY}","reused":true,"reused_legacy_key":true,"base_fallbacks":[{"reference":"${reference}","resolved_at_unix_seconds":0},{"reference":"invalid reference","resolved_at_unix_seconds":0}]}'`
  );
  const waiting: (string | null)[] = [];
  const built = await invokeNativeBuild({
    runtime: fake as never,
    cwd: fake.home,
    requestFile: join(fake.home, "request.json"),
    onImageWait: (value) => waiting.push(value),
    write: () => {
      throw new Error("Expected the image-wait markers to be consumed");
    },
  });
  expect(waiting).toEqual([reference, null, null]);
  expect(built.baseFallbacks).toHaveLength(2);
  expect(built.baseFallbacks?.[0]).toContain(reference);
  expect(built.baseFallbacks?.[1]).toContain(
    "unchanged context and Dockerfile"
  );
});

test.each([
  { cpus: 4, cap: 3, outcome: "success" },
  { cpus: 2, cap: 2, outcome: "success" },
  { cpus: 1, cap: 1, outcome: "success" },
  { cpus: 4, cap: 3, outcome: "failure" },
  { cpus: 4, cap: 3, outcome: "interrupt" },
] as const)("build batch $outcome with $cpus guest CPUs", async ({
  cpus,
  cap,
  outcome,
}) => {
  const project = await root();
  const controller = new AbortController();
  const names = ["web", "worker", "tools", "jobs"];
  const builds = new Map(
    names.map((target) => [target, { ...request(), target }])
  );
  builds.set("duplicate", {
    ...request(),
    dockerfile: "./Dockerfile",
    target: "web",
  });
  const specs: Record<string, Record<string, unknown>> = Object.fromEntries(
    [...builds.keys()].map((name) => [name, { build: "app" }])
  );
  const started: string[] = [];
  const releases = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<boolean>>
  >();
  const cancelled = new Set<string>();
  const completed: string[] = [];
  const settlements: string[] = [];
  let returned = false;
  const result = buildNativeProjectImages({
    runtime: { binary: "/test/runtime", home: project } as never,
    projectRoot: project,
    branch: null,
    profiles: [],
    builds,
    specs,
    rebuild: false,
    guestCpus: cpus,
    signal: controller.signal,
    onBuildSettled: ({ outcome: decision, services }) => {
      settlements.push(`${services.join(",")}: ${decision}`);
    },
    invoke: async ({ requestFile, signal }) => {
      const target =
        names[Number(/request-(\d+)\.json$/.exec(requestFile)?.[1])];
      if (target === undefined) {
        throw new Error("Unexpected request index");
      }
      expect(releases.size).toBeLessThan(cap);
      started.push(target);
      const release = Promise.withResolvers<boolean>();
      releases.set(target, release);
      signal?.addEventListener("abort", () => cancelled.add(target), {
        once: true,
      });
      const fail = await release.promise;
      releases.delete(target);
      completed.push(target);
      if (fail || cancelled.has(target)) {
        throw new NativeRuntimeRequestError({
          message: `fixture ${target}`,
          nativeCode: "native_build_failed",
        });
      }
      return { imageId: IMAGE, buildKey: KEY, reused: false };
    },
  })
    .catch((error: unknown) => error)
    .finally(() => {
      returned = true;
    });

  const waitFor = async (condition: () => boolean) => {
    const end = performance.now() + 2000;
    while (!(condition() || returned) && performance.now() < end) {
      await Bun.sleep(2);
    }
    expect(condition()).toBe(true);
  };
  try {
    await waitFor(() => started.length === cap);
    expect(started).toEqual(names.slice(0, cap));
    if (outcome === "success") {
      for (let index = 0; index < names.length; index++) {
        const name = names[index] ?? "";
        await waitFor(() => releases.has(name));
        releases.get(name)?.resolve(false);
      }
      expect(await result).toEqual(new Set([...builds.keys()]));
      expect(started).toEqual(names);
      expect(specs.duplicate).toEqual({ image: IMAGE });
      expect(settlements).toHaveLength(names.length);
    } else {
      if (outcome === "failure") {
        releases.get("worker")?.resolve(true);
        await waitFor(() => cancelled.has("web"));
      } else {
        controller.abort();
        await waitFor(() => cancelled.size === cap);
      }
      expect(returned).toBe(false);
      for (const release of releases.values()) {
        release.resolve(false);
      }
      const error = await result;
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain(
        outcome === "failure"
          ? "service worker: fixture worker"
          : "was canceled"
      );
      expect(started).toEqual(names.slice(0, cap));
      expect(completed.toSorted()).toEqual(names.slice(0, cap).toSorted());
      expect(releases.size).toBe(0);
    }
  } finally {
    controller.abort();
    for (const release of releases.values()) {
      release.resolve(false);
    }
    await result;
  }
});

test("concurrent builds share a physical command pin directory and deduplicate notices", async () => {
  const projectRoot = await root();
  const arrived = Promise.withResolvers<void>();
  const directories: string[] = [];
  const notices: string[] = [];
  const base = "docker.io/library/alpine:latest";
  const pin = `docker.io/library/alpine@${IMAGE}`;
  const notice = "Using a previously verified base.";
  const physical = join(await realpath(projectRoot), "physical");
  const alias = join(projectRoot, "alias");
  const previous = process.env.TMPDIR;
  await mkdir(join(physical, "tmp"), { recursive: true });
  await symlink(physical, alias);
  process.env.TMPDIR = join(alias, "tmp");
  try {
    await buildNativeProjectImages({
      runtime,
      projectRoot,
      branch: null,
      profiles: [],
      builds: new Map([
        ["one", request()],
        ["two", request({})],
      ]),
      specs: { one: { build: "app" }, two: { build: "app" } },
      rebuild: false,
      guestCpus: 2,
      imageTagMode: "refresh",
      signal: new AbortController().signal,
      onNotice: (line) => notices.push(line),
      invoke: async ({ requestFile }) => {
        const body = JSON.parse(await readFile(requestFile, "utf8"));
        expect(body.share_command_base_pins).toBe(true);
        expect(body.image_tag_mode).toBe("refresh");
        directories.push(dirname(requestFile));
        if (directories.length === 2) {
          arrived.resolve();
        }
        await arrived.promise;
        return {
          imageId: IMAGE,
          buildKey: KEY,
          reused: false,
          baseSelections: { [base]: pin },
          baseFallbacks: [notice],
        };
      },
    });
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "TMPDIR");
    } else {
      process.env.TMPDIR = previous;
    }
  }
  expect(directories).toHaveLength(2);
  expect(new Set(directories.map(dirname))).toEqual(
    new Set([join(physical, "tmp")])
  );
  expect(new Set(directories).size).toBe(1);
  expect(notices).toEqual([notice]);
});

test("native runtime requests centralize temporary paths", async () => {
  const backends = fileURLToPath(new URL("../src/backends/", import.meta.url));
  const unresolved: string[] = [];
  for await (const file of new Bun.Glob("*.ts").scan(backends)) {
    const source = await Bun.file(join(backends, file)).text();
    // The HTTPS FIFO is consumed by the shell before exec, not by the runtime.
    const requests = source.replace(
      'mkdtempSync(join(tmpdir(), "hk-https-pipe-"))',
      ""
    );
    if (requests.replaceAll("realpath(tmpdir())", "").includes("tmpdir()")) {
      unresolved.push(file);
    }
  }
  expect(unresolved).toEqual([]);
});
