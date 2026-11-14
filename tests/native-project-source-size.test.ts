import { expect, test } from "bun:test";
import {
  nativeCacheInitializers,
  nativeSharedSourceFlags,
} from "../src/backends/native-project-cache.ts";
import {
  formatNativeSourceBytes,
  parseNativeSourceSize,
  requireCapturedNativeSourceWithinLimit,
  requireNativeSourceWithinLimit,
} from "../src/backends/native-project-source-size.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";
import {
  nativeComposeServiceSourceUse,
  nativeComposeSourceCaptured,
  nativePlanServiceSourceUse,
  nativeSourceCaptured,
} from "../src/backends/native-source-capture.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import {
  checkNativeSourceSize,
  NATIVE_SOURCE_CHECK,
} from "../src/lib/doctor-native-source.ts";
import { nativeSourceSizeReceipt } from "./helpers/native-source-size.ts";

/**
 * HACK-1965: the native source limit is measured by the runtime before any runtime,
 * image or build work, and doctor predicts the refusal. The runtime is a fake that
 * returns synthetic receipts; nothing here starts a runtime, Docker or a VM.
 */
const runtime = { binary: "/candidate/hack-native", home: "/candidate/home" };
const MIB = 1024 * 1024;

test("the source size request is a metadata-only runtime command on the exact root", async () => {
  const size = await requireNativeSourceWithinLimit({
    runtime,
    projectRoot: "/work/app",
    invoke: async (request) => {
      expect(request.runtime).toEqual(runtime);
      expect(request.cwd).toBe(runtime.home);
      expect(request.args).toEqual([
        "project",
        "source-size",
        "--project",
        "/work/app",
        "--json",
      ]);
      expect(request.timeoutMs).toBe(20_000);
      return nativeSourceSizeReceipt();
    },
  });
  expect(size.withinLimit).toBe(true);
  expect(size.limitBytes).toBe(128 * MIB);
});

test("over the limit refuses with the size, limit, largest paths and both remedies", async () => {
  const refusal = await requireNativeSourceWithinLimit({
    runtime,
    projectRoot: "/work/app",
    invoke: async () =>
      nativeSourceSizeReceipt({ totalBytes: Math.round(237.4 * MIB) }),
  }).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(HackCliError);
  const error = refusal as HackCliError;
  expect(error.code).toBe("E_NATIVE_PROJECT_UNSUPPORTED");
  expect(error.message).not.toContain("\n");
  for (const fragment of [
    "237.4 MiB",
    "native source limit is 128 MiB (default)",
    "no runtime, image or build work was started",
    "Largest directories: assets (",
    "assets/video (",
    "Largest files: assets/video/intro.bin (",
    ".gitignore or .ignore",
    "raise native.sourceLimitMiB in .hack/hack.config.json (maximum 512)",
  ]) {
    expect(error.message).toContain(fragment);
  }
});

test("a project already at the maximum limit is only told to exclude paths", async () => {
  const refusal = await requireNativeSourceWithinLimit({
    runtime,
    projectRoot: "/work/app",
    invoke: async () =>
      nativeSourceSizeReceipt({
        totalBytes: 600 * MIB,
        limitMiB: 512,
        limitOrigin: "project",
      }),
  }).catch((error: unknown) => error);
  const message = (refusal as HackCliError).message;
  expect(message).toContain(
    "512 MiB (native.sourceLimitMiB in .hack/hack.config.json)"
  );
  expect(message).not.toContain("raise native.sourceLimitMiB");
});

test("only a complete, self-consistent receipt is admitted", async () => {
  const valid = nativeSourceSizeReceipt();
  expect(parseNativeSourceSize(valid)).toBeDefined();
  for (const invalid of [
    null,
    {},
    { ...valid, schema_version: 2 },
    { ...valid, within_limit: false },
    { ...valid, total_bytes: -1 },
    { ...valid, limit_bytes: 0 },
    { ...valid, limit_bytes: 1024 * MIB },
    { ...valid, limit_origin: "machine" },
    { ...valid, largest_files: [{ path: "/etc/hosts", bytes: 1 }] },
    { ...valid, largest_files: [{ path: "a\nb", bytes: 1 }] },
    {
      ...valid,
      largest_directories: Array.from({ length: 6 }, (_, i) => ({
        path: `d${i}`,
        bytes: 1,
      })),
    },
  ]) {
    expect(parseNativeSourceSize(invalid)).toBeUndefined();
    const refusal = await requireNativeSourceWithinLimit({
      runtime,
      projectRoot: "/work/app",
      invoke: async () => invalid,
    }).catch((error: unknown) => error);
    expect(String(refusal)).toContain("invalid receipt");
  }
});

test("byte sizes print in the closest binary unit", () => {
  expect(formatNativeSourceBytes(12)).toBe("12 B");
  expect(formatNativeSourceBytes(1536)).toBe("1.5 KiB");
  expect(formatNativeSourceBytes(128 * MIB)).toBe("128 MiB");
  expect(formatNativeSourceBytes(173.25 * MIB)).toBe("173.3 MiB");
});

test("doctor reports the size within the limit and warns over it", async () => {
  const ok = await checkNativeSourceSize({
    runtime,
    projectRoot: "/work/app",
    invoke: async () => nativeSourceSizeReceipt(),
  });
  expect(ok.name).toBe(NATIVE_SOURCE_CHECK);
  expect(ok.status).toBe("ok");
  expect(ok.message).toContain("native source limit is 128 MiB");
  expect(ok.nativeSource?.totalBytes).toBe(4096);

  const over = await checkNativeSourceSize({
    runtime,
    projectRoot: "/work/app",
    invoke: async () => nativeSourceSizeReceipt({ totalBytes: 140 * MIB }),
  });
  expect(over.status).toBe("warn");
  expect(over.message).toContain("140 MiB");
  expect(over.message).toContain("Native up and restart refuse");
  expect(over.message).toContain("Largest directories: assets");
  expect(over.nativeSource?.largestDirectories[0]?.path).toBe("assets");
});

test("doctor warns when the runtime cannot measure the source", async () => {
  const failed = await checkNativeSourceSize({
    runtime,
    projectRoot: "/work/app",
    invoke: async () => {
      throw new NativeRuntimeRequestError({
        message:
          "Native runtime request failed (source_limit_config); inspect owned state before retrying.",
        nativeCode: "source_limit_config",
      });
    },
  });
  expect(failed.status).toBe("warn");
  expect(failed.message).toContain("could not be measured");
  expect(failed.message).toContain("source_limit_config");
  expect(failed.nativeSource).toBeUndefined();
});

test("only a graph that captures source is measured and limited", async () => {
  const image = `sha256:${"e".repeat(64)}`;
  const measured: string[] = [];
  const check = (services: Record<string, Record<string, unknown>>) =>
    requireCapturedNativeSourceWithinLimit({
      runtime,
      projectRoot: "/work/app",
      services,
      profiles: ["app"],
      invoke: async (request) => {
        measured.push(request.args[1] ?? "");
        return nativeSourceSizeReceipt({ totalBytes: 140 * MIB });
      },
    });
  // Image-only, named volumes, a lone bootstrap label and inactive profiles: no capture.
  expect(
    await check({
      web: { image, volumes: ["data:/var/lib/data"] },
      db: {
        image,
        volumes: [{ type: "volume", source: "db", target: "/db" }],
        labels: { "hack.dependencies.bootstrap": "true" },
      },
      tools: { image, profiles: ["tools"], volumes: ["./src:/src"] },
    })
  ).toBeUndefined();
  expect(measured).toEqual([]);
  // A bind mount (short or long syntax) or a dependency cache: refused over the limit.
  for (const web of [
    { image, volumes: ["./src:/app:ro"] },
    { image, volumes: [{ type: "bind", source: ".", target: "/app" }] },
    { image, labels: ["hack.dependencies.cache-volume=modules"] },
    { image, profiles: ["app"], volumes: ["/abs/src:/app"] },
  ]) {
    await expect(check({ web })).rejects.toBeInstanceOf(HackCliError);
  }
  expect(measured).toEqual([
    "source-size",
    "source-size",
    "source-size",
    "source-size",
  ]);
});

test("unclassifiable Compose declarations keep the source limit", () => {
  for (const service of [
    { volumes: "./src:/app" },
    { volumes: [42] },
    { volumes: ["$HOME/src:/app"] },
    { volumes: [{ type: "tmpfs", target: "/tmp" }] },
    { labels: "hack.dependencies.cache-volume=modules" },
  ]) {
    expect(
      nativeComposeSourceCaptured({ services: { web: service }, profiles: [] })
    ).toBe(true);
  }
});

test("the startup source flags and the source limit share one capture predicate", () => {
  const plan = {
    services: {
      web: { active: true, mounts: [{ kind: "volume" }] },
      off: { active: false, mounts: [{ kind: "bind" }] },
      cacheOff: { active: false, dependency_cache: { volume: "m" } },
    },
  };
  const uses = Object.values(plan.services).map(nativePlanServiceSourceUse);
  expect(nativeSharedSourceFlags(plan)).toEqual([]);
  expect(nativeCacheInitializers(plan).size).toBe(0);
  expect(nativeSourceCaptured(uses)).toBe(false);
  for (const service of [
    { active: true, mounts: [{ kind: "bind" }] },
    { active: true, dependency_cache: { volume: "m" } },
  ]) {
    const selected = { services: { ...plan.services, app: service } };
    const flagged =
      nativeSharedSourceFlags(selected).length > 0 ||
      nativeCacheInitializers(selected).size > 0;
    expect(flagged).toBe(true);
    expect(
      nativeSourceCaptured(
        Object.values(selected.services).map(nativePlanServiceSourceUse)
      )
    ).toBe(true);
  }
  // The Compose reading before review agrees with the plan reading for these forms.
  expect(
    nativeComposeServiceSourceUse({ volumes: ["./src:/app"] }, [])
  ).toEqual(
    nativePlanServiceSourceUse({ active: true, mounts: [{ kind: "bind" }] })
  );
  // An anonymous volume shares no source; an unclear form still counts as a bind.
  for (const anonymous of ["/app/node_modules", "/data:ro", { target: "/d" }]) {
    expect(
      nativeComposeServiceSourceUse({ volumes: [anonymous] }, []).bindsSource
    ).toBe(false);
  }
  for (const bind of ["/host:/app", "/data:ro:extra", "data"]) {
    expect(
      nativeComposeServiceSourceUse({ volumes: [bind] }, []).bindsSource
    ).toBe(true);
  }
  expect(
    nativeComposeServiceSourceUse(
      { labels: { "hack.dependencies.cache-volume": "m" } },
      []
    )
  ).toEqual(
    nativePlanServiceSourceUse({
      active: true,
      mounts: [],
      dependency_cache: { volume: "m" },
    })
  );
});
