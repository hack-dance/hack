import { expect, test } from "bun:test";
import {
  formatNativeSourceBytes,
  parseNativeSourceSize,
  requireNativeSourceWithinLimit,
} from "../src/backends/native-project-source-size.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";
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
