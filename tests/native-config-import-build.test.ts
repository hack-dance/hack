import { expect, spyOn, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  nativeImportBuildProjection,
  runNativeImportBuildConfig,
} from "../scripts/check-native-config-import-build.ts";
import { isRecord } from "../src/lib/guards.ts";
import { mapLegacyComposeBuild } from "../src/lib/native-config-import-build.ts";
import {
  mapLegacyNativeImport,
  mapLegacyNativeStorageAdoption,
} from "../src/lib/native-config-import-plan.ts";

const CANARY = "synthetic-private-build-import";
function mapped(service: unknown, inactive = false) {
  return mapLegacyNativeImport({
    configText: '{"name":"fixture"}',
    composeText: JSON.stringify({
      services: {
        web: { image: "fixture:1" },
        builder: {
          ...(typeof service === "object" && service !== null ? service : {}),
          ...(inactive ? { profiles: ["later"] } : {}),
        },
      },
    }),
  });
}
function refused(result: ReturnType<typeof mapped>, code: string) {
  expect(result.report.complete).toBe(false);
  expect(result.candidate).toBeUndefined();
  expect(result.report.fields).toContainEqual(
    expect.objectContaining({ status: "refused", code })
  );
  expect(JSON.stringify(result)).not.toContain(CANARY);
}

test.each([
  [".", ".hack"],
  ["./", ".hack"],
  ["..", "."],
  ["../apps/api", "apps/api"],
  ["./context//nested/", ".hack/context/nested"],
  ["../apps/./api/../web", "apps/web"],
  ["build-$${AMBIENT}", ".hack/build-${AMBIENT}"],
  ["../literal-$$$$/percent-%{value}", "literal-$$/percent-%{value}"],
])("short build %p preserves its legacy base as native context %p", (input, context) => {
  const result = mapped({ build: input });
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toMatchObject({
    services: { builder: { build: { context } } },
  });
  expect(result.report.fields).toContainEqual(
    expect.objectContaining({
      pointer: "/services/builder/build",
      target: "/services/builder/build/context",
      status: "normalized",
      code: "compose_short_build_context",
    })
  );
  expect(JSON.stringify(result)).not.toContain(context);
});

test("object context/default Dockerfile/stage/policy preserve absence and authored values", () => {
  const source = {
    build: { context: "../app", target: "stage.v1_selected" },
    pull_policy: "build",
    command: ["echo", "$${NOT_EXPANDED}"],
  };
  const before = JSON.stringify(source);
  const result = mapped(source, true);
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toMatchObject({
    profiles: ["later"],
    services: {
      builder: {
        build: { context: "app", target: "stage.v1_selected" },
        pull_policy: "build",
        command: { exec: ["echo", "${NOT_EXPANDED}"] },
        profiles: ["later"],
      },
    },
  });
  expect(JSON.stringify(source)).toBe(before);
  expect(result.candidate).not.toHaveProperty(
    "services.builder.build.dockerfile"
  );
  expect(Object.keys(result)).toEqual(["report"]);
  expect(Object.isFrozen(result.candidate)).toBe(true);
  expect(JSON.stringify(result)).not.toContain("${NOT_EXPANDED}");
});

test.each([
  {},
  { dockerfile: "docker/Dockerfile" },
  { target: "selected" },
])("object build %p with omitted context retains the Compose default directory", (build) => {
  const result = mapped({ build });
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toMatchObject({
    services: { builder: { build: { context: ".hack", ...build } } },
  });
  expect(result.report.fields).toContainEqual(
    expect.objectContaining({
      pointer: "/services/builder/build",
      code: "compose_build_context_default",
      status: "normalized",
    })
  );
  expect(result.candidate).not.toHaveProperty("services.builder.pull_policy");
});

test("explicit nested Dockerfile dollars decode once and remain context relative", () => {
  const result = mapped({
    build: {
      context: "../app-$${AMBIENT}",
      dockerfile: "./docker//Dockerfile-$$$$-$${AMBIENT}",
      target: "constructor",
    },
  });
  expect(result.report.complete).toBe(true);
  expect(result.candidate).toMatchObject({
    services: {
      builder: {
        build: {
          context: "app-${AMBIENT}",
          dockerfile: "docker/Dockerfile-$$-${AMBIENT}",
          target: "constructor",
        },
      },
    },
  });
  expect(result.report.fields).toContainEqual(
    expect.objectContaining({
      pointer: "/services/builder/build/dockerfile",
      target: "/services/builder/build/dockerfile",
      code: "compose_build_path_literal",
      status: "normalized",
    })
  );
});

test("report binds authored build leaf locations without emitting private paths", () => {
  const result = mapLegacyNativeImport({
    configText: '{"name":"fixture"}',
    composeText: `services:\n  builder:\n    build:\n      context: ../${CANARY}\n      dockerfile: Dockerfile\n      target: selected\n`,
  });
  expect(result.report.complete).toBe(true);
  expect(result.report.fields).toContainEqual({
    document: "compose",
    pointer: "/services/builder/build/context",
    line: 4,
    column: 7,
    status: "normalized",
    code: "compose_build_context_rebased",
    target: "/services/builder/build/context",
  });
  expect(JSON.stringify(result)).not.toContain(CANARY);
  expect(JSON.stringify({ ...result })).not.toContain(CANARY);
});

test.each([
  "args",
  "cache_from",
  "cache_to",
  "ssh",
  "secrets",
  "labels",
  "network",
  "platform",
  "platforms",
  "additional_contexts",
  "pull",
  "no_cache",
  "dockerfile_inline",
  "tags",
  "extra_hosts",
  "entitlements",
  "privileged",
  "provenance",
  "sbom",
  "shm_size",
  "ulimits",
  "isolation",
  "constructor",
])("unknown build field %s refuses selected and inactive inputs without image fallback", (field) => {
  for (const inactive of [false, true]) {
    for (const extra of [null, false, [], {}, CANARY]) {
      const result = mapped(
        { build: { context: "..", [field]: extra } },
        inactive
      );
      refused(result, "invalid_or_unsupported_build");
      expect(result.report.fields).toContainEqual(
        expect.objectContaining({
          pointer: `/services/builder/build/${field}`,
          status: "refused",
          code: "unsupported_field",
        })
      );
    }
  }
});

test.each(
  [
    null,
    false,
    7,
    [],
    [".."],
    "",
    "../../outside",
    "/absolute",
    "~/home",
    "https://host/repo.git",
    "git@host:repo",
    "C:\\build",
    "../nul\0path",
    "../line\npath",
    "../line\rpath",
    "../$VAR",
    "../${VAR}",
    "../$$$",
    { context: null },
    { context: [] },
    { context: false },
    { context: "..", dockerfile: null },
    { context: "..", dockerfile: "../Dockerfile" },
    { context: "..", dockerfile: "docker/../../Dockerfile" },
    { context: "..", dockerfile: "." },
    { context: "..", dockerfile: "Dockerfile/" },
    { context: "..", dockerfile: "/Dockerfile" },
    { context: "..", dockerfile: "~/Dockerfile" },
    { context: "..", dockerfile: "${PRIVATE}" },
    { context: "..", target: null },
    { context: "..", target: "Upper" },
    { context: "..", target: "${PRIVATE}" },
    { context: "..", target: "a".repeat(64) },
  ].map((build) => [build] as const)
)("invalid build shape/path %p refuses in an inactive profile", (build) => {
  const result = mapped({ build }, true);
  refused(result, "invalid_or_unsupported_build");
});

test.each([
  "always",
  "never",
  "missing",
  "weekly",
  null,
  true,
])("build policy %p cannot become a default or image policy", (pull_policy) => {
  refused(
    mapped({ build: "..", pull_policy }, true),
    "invalid_or_ambiguous_value"
  );
});

test.each([
  "fixture:1",
  null,
  "",
  CANARY,
])("combined image %p and build refuse both source fields instead of falling back", (image) => {
  const result = mapped({ image, build: "..", pull_policy: "build" });
  refused(result, "image_build_exclusive");
  for (const field of ["image", "build"]) {
    expect(result.report.fields).toContainEqual(
      expect.objectContaining({
        pointer: `/services/builder/${field}`,
        code: "image_build_exclusive",
        status: "refused",
      })
    );
  }
});

test("image-only mapping and acquisition intent remain unchanged", () => {
  for (const policy of [undefined, "always", "never", "missing"]) {
    const service = {
      image: "fixture:1",
      ...(policy ? { pull_policy: policy } : {}),
    };
    const result = mapped(service);
    expect(result.report.complete).toBe(true);
    expect(result.candidate).toMatchObject({ services: { builder: service } });
  }
  refused(
    mapped({ image: "fixture:1", pull_policy: "build" }),
    "invalid_or_ambiguous_value"
  );
});

test("preview build capability never grants retained storage adoption", () => {
  for (const service of [
    { build: ".." },
    { image: "fixture:1", build: ".." },
  ]) {
    const result = mapLegacyNativeStorageAdoption({
      configText: '{"name":"fixture"}',
      composeText: JSON.stringify({ services: { builder: service } }),
    });
    expect(result.report.complete).toBe(false);
    expect(result.candidate).toBeUndefined();
    expect(result.report.fields).toContainEqual(
      expect.objectContaining({
        pointer: "/services/builder/build",
        code: "unsupported_field",
        status: "refused",
      })
    );
  }
});

test("pure helper ignores inherited source keys and never mutates its input", () => {
  const build = {
    context: "..",
    dockerfile: "./docker/Dockerfile",
    target: "selected",
  };
  const before = JSON.stringify(build);
  expect(mapLegacyComposeBuild(build)?.build).toEqual({
    context: ".",
    dockerfile: "docker/Dockerfile",
    target: "selected",
  });
  expect(JSON.stringify(build)).toBe(before);
  expect(
    mapLegacyComposeBuild(
      Object.create({ context: "../../foreign", secrets: CANARY })
    )?.build
  ).toEqual({ context: ".hack" });
});

test("basic-build mapping cannot invoke a compiler, Docker, Compose or builder", () => {
  const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("Pure mapping must not spawn");
  });
  const spawnSync = spyOn(Bun, "spawnSync").mockImplementation(() => {
    throw new Error("Pure mapping must not spawn");
  });
  try {
    expect(
      mapped({ build: { context: "..", target: "selected" } }).report.complete
    ).toBe(true);
    refused(
      mapped({ build: { context: "..", args: { PRIVATE: CANARY } } }, true),
      "invalid_or_unsupported_build"
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
    spawnSync.mockRestore();
  }
});

test("config-only correspondence projection rejects altered source/stage/policy and extra build options", () => {
  const base = {
    services: Object.fromEntries(
      ["default", "root", "nested", "literal"].map((name) => [
        name,
        {
          build: {
            context: "/verified/context",
            dockerfile: "./docker/Dockerfile",
          },
        },
      ])
    ),
  };
  const expected = Object.fromEntries(
    ["default", "literal", "nested", "root"].map((name) => [
      name,
      {
        context: "/verified/context",
        dockerfile: "/verified/context/docker/Dockerfile",
      },
    ])
  );
  expect(nativeImportBuildProjection(base)).toEqual(expected);
  for (const changed of [
    { build: undefined },
    { image: "fallback", build: base.services.root?.build },
    { build: { context: "relative", dockerfile: "Dockerfile" } },
    {
      build: {
        context: "/verified/context",
        dockerfile: "/foreign/Dockerfile",
      },
    },
    {
      build: {
        context: "/verified/context",
        dockerfile: "Dockerfile",
        args: {},
      },
    },
    {
      build: {
        context: "/verified/context",
        dockerfile: "Dockerfile",
        target: null,
      },
    },
    {
      build: Object.create({
        context: "/verified/context",
        dockerfile: "Dockerfile",
      }),
    },
    { build: base.services.root?.build, pull_policy: "never" },
  ]) {
    expect(() =>
      nativeImportBuildProjection({
        services: { ...base.services, root: changed },
      })
    ).toThrow();
  }
  for (const changed of [
    { ...base.services, extra: base.services.root },
    { default: base.services.default },
  ]) {
    expect(() => nativeImportBuildProjection({ services: changed })).toThrow();
  }
  for (const build of [
    { context: "/verified/foreign", dockerfile: "Dockerfile" },
    { context: "/verified/context", dockerfile: "wrong/Dockerfile" },
    {
      context: "/verified/context",
      dockerfile: "./docker/Dockerfile",
      target: "foreign",
    },
  ]) {
    expect(
      nativeImportBuildProjection({
        services: { ...base.services, root: { build } },
      })
    ).not.toEqual(expected);
  }
});

async function commandFixture(
  body: string,
  check: (
    opts: {
      readonly binary: string;
      readonly cwd: string;
      readonly file: string;
      readonly env: Readonly<Record<string, string>>;
      readonly timeoutMs: number;
    },
    root: string
  ) => Promise<void>
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "build-import-capture-"))
  );
  const binary = join(root, "compose");
  try {
    await writeFile(binary, `#!${process.execPath}\n${body}\n`, {
      mode: 0o700,
    });
    await chmod(binary, 0o700);
    await check(
      {
        binary,
        cwd: root,
        file: join(root, "input"),
        env: { PATH: "/usr/bin:/bin" },
        timeoutMs: 500,
      },
      root
    );
  } finally {
    await rm(root, { recursive: true });
  }
}

test("config projection preserves escaped dollar serialization without another decode or ambient expansion", () => {
  const source = (context: string, dockerfile: string) => ({
    services: Object.fromEntries(
      ["default", "root", "nested", "literal"].map((name) => [
        name,
        { build: { context, dockerfile } },
      ])
    ),
  });
  const context = "/verified/literal-$${AMBIENT}";
  const dockerfile = "docker/Dockerfile-$${AMBIENT}";
  const expected = Object.fromEntries(
    ["default", "literal", "nested", "root"].map((name) => [
      name,
      { context, dockerfile: `${context}/${dockerfile}` },
    ])
  );
  expect(nativeImportBuildProjection(source(context, dockerfile))).toEqual(
    expected
  );
  for (const altered of [
    source("/verified/literal-${AMBIENT}", dockerfile),
    source(context, "docker/Dockerfile-${AMBIENT}"),
    source("/verified/literal-$$$${AMBIENT}", dockerfile),
    source(
      "/verified/literal-must-not-expand",
      "docker/Dockerfile-must-not-expand"
    ),
  ]) {
    expect(nativeImportBuildProjection(altered)).not.toEqual(expected);
  }
});

test("normal completed config capture and later publication refusal never signal a former group", async () => {
  await commandFixture('console.log("bounded");', async (opts) => {
    const signal = spyOn(process, "kill");
    try {
      expect((await runNativeImportBuildConfig(opts)).stdout).toBe("bounded\n");
      expect(signal).not.toHaveBeenCalled();
      await expect(
        runNativeImportBuildConfig({
          ...opts,
          onSettled: async () => {
            throw new Error("private publication failure");
          },
        })
      ).rejects.toThrow("values omitted");
      expect(signal).not.toHaveBeenCalled();
    } finally {
      signal.mockRestore();
    }
  });
});

test("leader exit leaves descendant-held capture cleanup armed until bounded refusal", async () => {
  await commandFixture(
    `
    const keeper = Bun.spawn([process.execPath, "-e", 'process.on("SIGTERM",()=>{}); await Bun.sleep(1500); await Bun.write("late-marker","unexpected");'], {stdin:"ignore",stdout:"inherit",stderr:"inherit"});
    await Bun.write("keeper",String(keeper.pid));
    keeper.unref();
    process.exit(0);
  `,
    async (opts, root) => {
      const started = performance.now();
      await expect(runNativeImportBuildConfig(opts)).rejects.toThrow(
        "values omitted"
      );
      expect(performance.now() - started).toBeLessThan(2500);
      const pid = Number(await readFile(join(root, "keeper"), "utf8"));
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      const deadline = Date.now() + 1000;
      while (true) {
        try {
          process.kill(pid, 0);
        } catch (error: unknown) {
          if (isRecord(error) && error.code === "ESRCH") {
            break;
          }
          throw new Error("Owned descendant absence was not proven");
        }
        if (Date.now() >= deadline) {
          throw new Error("Owned descendant remained live");
        }
        await Bun.sleep(5);
      }
      expect(await Bun.file(join(root, "late-marker")).exists()).toBe(false);
    }
  );
});

test.each([
  "overflow",
  "read-failure",
])("capture %s kills and reaps before fixture cleanup", async (mode) => {
  await commandFixture(
    `
    await Bun.write("leader",String(process.pid));
    process.stdout.write(${mode === "overflow" ? '"x".repeat(256*1024+1)' : '"fault"'});
    await Bun.sleep(1500);
    await Bun.write("late-marker","unexpected");
  `,
    async (opts, root) => {
      await expect(
        runNativeImportBuildConfig({
          ...opts,
          ...(mode === "read-failure"
            ? {
                afterRead: () => {
                  throw new Error("private stream failure");
                },
              }
            : {}),
        })
      ).rejects.toThrow("values omitted");
      const pid = Number(await readFile(join(root, "leader"), "utf8"));
      let absent = false;
      try {
        process.kill(pid, 0);
      } catch (error: unknown) {
        absent = isRecord(error) && error.code === "ESRCH";
      }
      expect(absent).toBe(true);
      expect(await Bun.file(join(root, "late-marker")).exists()).toBe(false);
    }
  );
});
