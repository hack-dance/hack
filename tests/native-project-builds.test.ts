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
  type NativeBuildRequest,
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

test("builds refuse unless explicitly enabled, and projects without builds are unaffected", () => {
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
    profiles: [],
    builds: new Map([
      ["one", request()],
      ["two", request()],
      ["other", { ...request(), target: "dev" }],
    ]),
    specs,
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
