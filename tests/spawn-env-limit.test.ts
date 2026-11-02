import { expect, test } from "bun:test";
import { HackCliError } from "../src/lib/cli-result.ts";
import {
  assertComposeSpawnEnvFits,
  DARWIN_ARG_MAX_BYTES,
  LINUX_MAX_ARG_STRLEN_BYTES,
  linuxArgMaxBytes,
  measureSpawnEnv,
  parseLinuxStackSoftLimit,
  SPAWN_ARGV_RESERVE_BYTES,
  spawnEnvLimitForPlatform,
  spawnEnvOverflow,
} from "../src/lib/spawn-env-limit.ts";

/**
 * HACK-1317: the Compose environment is checked against the platform's
 * process argument limit before Compose starts. Values are synthetic and
 * assembled here; the error must carry byte counts only.
 */
const CANARY = "g45-limit-canary";
const KIB = 1024;

function filler(bytes: number): string {
  return `${CANARY}${"v".repeat(Math.max(bytes - CANARY.length, 0))}`;
}

function caught(run: () => void): HackCliError {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof HackCliError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected E_ENV_TOO_LARGE");
}

test("measure counts NAME=value strings, NULs and pointers", () => {
  expect(measureSpawnEnv({})).toEqual({
    totalBytes: 8,
    largestStringBytes: 0,
  });
  expect(measureSpawnEnv({ AB: "xyz", C: "" })).toEqual({
    // "AB=xyz\0" (7) + "C=\0" (3) + three pointers (24).
    totalBytes: 34,
    largestStringBytes: 7,
  });
  expect(measureSpawnEnv({ K: "é" }).largestStringBytes).toBe(5);
});

test("platform limits: macOS 1 MiB, Linux a quarter of the stack within bounds", () => {
  expect(spawnEnvLimitForPlatform({ platform: "darwin" })).toEqual({
    platform: "macOS",
    argMaxBytes: DARWIN_ARG_MAX_BYTES,
    envBytes: DARWIN_ARG_MAX_BYTES - SPAWN_ARGV_RESERVE_BYTES,
    singleStringBytes: null,
  });
  const linux = spawnEnvLimitForPlatform({ platform: "linux" });
  expect(linux.argMaxBytes).toBe(2 * KIB * KIB);
  expect(linux.singleStringBytes).toBe(LINUX_MAX_ARG_STRLEN_BYTES);
  expect(linuxArgMaxBytes(8 * KIB * KIB)).toBe(2 * KIB * KIB);
  expect(linuxArgMaxBytes(null)).toBe(6 * KIB * KIB);
  expect(linuxArgMaxBytes(64 * KIB * KIB)).toBe(6 * KIB * KIB);
  expect(linuxArgMaxBytes(256 * KIB)).toBe(128 * KIB);
  expect(
    spawnEnvLimitForPlatform({
      platform: "linux",
      linuxStackSoftLimitBytes: 256 * KIB,
    }).envBytes
  ).toBe(64 * KIB);
  expect(spawnEnvLimitForPlatform({ platform: "freebsd" }).argMaxBytes).toBe(
    256 * KIB
  );
});

test("stack limit parsing reads the soft limit of /proc/self/limits", () => {
  const limits = [
    "Limit                     Soft Limit           Hard Limit           Units",
    "Max cpu time              unlimited            unlimited            seconds",
    "Max stack size            8388608              unlimited            bytes",
  ].join("\n");
  expect(parseLinuxStackSoftLimit(limits)).toBe(8 * KIB * KIB);
  expect(
    parseLinuxStackSoftLimit(
      "Max stack size            unlimited            unlimited            bytes"
    )
  ).toBeNull();
  expect(parseLinuxStackSoftLimit("")).toBeUndefined();
  expect(
    parseLinuxStackSoftLimit("Max stack size   nonsense   x   bytes")
  ).toBeUndefined();
});

test("overflow is reported at the boundary, per-string limit first", () => {
  const limit = spawnEnvLimitForPlatform({ platform: "darwin" });
  expect(
    spawnEnvOverflow({
      size: { totalBytes: limit.envBytes, largestStringBytes: 900 * KIB },
      limit,
    })
  ).toBeNull();
  expect(
    spawnEnvOverflow({
      size: { totalBytes: limit.envBytes + 1, largestStringBytes: 1 },
      limit,
    })
  ).toEqual({
    limit: "ARG_MAX",
    bytes: limit.envBytes + 1,
    limitBytes: limit.envBytes,
  });
  const linux = spawnEnvLimitForPlatform({ platform: "linux" });
  expect(
    spawnEnvOverflow({
      size: {
        totalBytes: LINUX_MAX_ARG_STRLEN_BYTES + 16,
        largestStringBytes: LINUX_MAX_ARG_STRLEN_BYTES,
      },
      limit: linux,
    })
  ).toBeNull();
  expect(
    spawnEnvOverflow({
      size: {
        totalBytes: 10 * KIB * KIB,
        largestStringBytes: LINUX_MAX_ARG_STRLEN_BYTES + 1,
      },
      limit: linux,
    })?.limit
  ).toBe("MAX_ARG_STRLEN");
});

test("an oversized environment fails closed with E_ENV_TOO_LARGE and no value", () => {
  const darwin = spawnEnvLimitForPlatform({ platform: "darwin" });
  // Twenty per-service copies of one 64 KiB value: the HACK-1317 shape.
  const perService = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [
      `HACK_ENV_${String(index).padStart(12, "0")}_BIG`,
      filler(64 * KIB),
    ])
  );
  const error = caught(() =>
    assertComposeSpawnEnvFits({
      env: perService,
      baseEnv: { PATH: "/usr/bin:/bin" },
      limit: darwin,
    })
  );
  expect(error.code).toBe("E_ENV_TOO_LARGE");
  expect(error.message).toContain("ARG_MAX");
  expect(error.message).toContain("macOS");
  expect(error.message).toContain("did not start docker compose");
  expect(error.message).toContain("global scope");
  expect(error.detail).toEqual({
    limit: "ARG_MAX",
    bytes: measureSpawnEnv({ PATH: "/usr/bin:/bin", ...perService }).totalBytes,
    limitBytes: darwin.envBytes,
  });
  const text = `${error.message}${JSON.stringify(error.detail)}`;
  expect(text.includes(CANARY)).toBe(false);
  expect(text.includes("HACK_ENV_")).toBe(false);

  // One shared copy fits.
  expect(() =>
    assertComposeSpawnEnvFits({
      env: { HACK_ENV_000000000000_BIG: filler(64 * KIB) },
      baseEnv: { PATH: "/usr/bin:/bin" },
      limit: darwin,
    })
  ).not.toThrow();

  // On Linux a single string over 128 KiB fails even though the total fits.
  const single = caught(() =>
    assertComposeSpawnEnvFits({
      env: { BIG: filler(LINUX_MAX_ARG_STRLEN_BYTES) },
      baseEnv: {},
      limit: spawnEnvLimitForPlatform({ platform: "linux" }),
    })
  );
  expect(single.code).toBe("E_ENV_TOO_LARGE");
  expect(single.message).toContain("MAX_ARG_STRLEN");
  expect(single.message).toContain("Linux");
  expect(`${single.message}${JSON.stringify(single.detail)}`).not.toContain(
    CANARY
  );
});

test("the inherited process environment counts toward the limit", () => {
  const limit = spawnEnvLimitForPlatform({ platform: "darwin" });
  const half = filler(500 * KIB);
  expect(() =>
    assertComposeSpawnEnvFits({ env: { A: half }, baseEnv: {}, limit })
  ).not.toThrow();
  expect(
    caught(() =>
      assertComposeSpawnEnvFits({
        env: { A: half },
        baseEnv: { INHERITED: half },
        limit,
      })
    ).code
  ).toBe("E_ENV_TOO_LARGE");
  // An override replaces the inherited value instead of adding to it.
  expect(() =>
    assertComposeSpawnEnvFits({ env: { A: half }, baseEnv: { A: half }, limit })
  ).not.toThrow();
});
