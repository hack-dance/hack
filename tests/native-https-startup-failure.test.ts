import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureNativeHttpsOwner } from "../src/backends/native-https-owner.ts";
import {
  nativeHttpsOwnerRoot,
  nativeHttpsReadFile,
} from "../src/backends/native-https-owner-storage.ts";
import {
  NativeHttpsStartupError,
  readNativeHttpsStartupFailure,
  recordNativeHttpsStartupFailure,
} from "../src/backends/native-https-startup-failure.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const home = await mkdtemp(
    join(await realpath(tmpdir()), "hk-startup-failure-")
  );
  roots.push(home);
  await chmod(home, 0o700);
  const configuration = await ensureNativeHttpsOwner({
    binding: {
      runtime: { home, binary: process.execPath },
      frontend: { binary: process.execPath, sha256: "a".repeat(64) },
      runtimeSha256: "b".repeat(64),
      pool: {
        owner: "c".repeat(32),
        bootId: "12345678-1234-1234-1234-123456789abc",
      },
      caddyBinary: process.execPath,
      caddySha256: "d".repeat(64),
      httpsPort: 19_443,
      certificateNameLimit: 256,
    },
    spawnOwner: async () => {},
  });
  const root = nativeHttpsOwnerRoot(home);
  const configurationPath = join(root, "configuration.json");
  const configurationIdentity = (await nativeHttpsReadFile(configurationPath))
    .identity;
  const error = new NativeHttpsStartupError(
    "authority-observation",
    new NativeRuntimeRequestError({
      message: "private stderr",
      nativeCode: "provider_busy",
    })
  );
  const opts = { configuration, configurationIdentity, error };
  const path = join(root, "startup-failure.json");
  return { home, configurationPath, path, opts };
}
test("startup receipt pins configuration bytes and emits only allowlisted classifications", async () => {
  const f = await fixture();
  expect(
    await readNativeHttpsStartupFailure(f.opts.configuration)
  ).toBeUndefined();
  await recordNativeHttpsStartupFailure(f.opts);
  const bytes = await readFile(f.path, "utf8");
  expect(bytes).not.toContain(f.home);
  expect(bytes).not.toContain("private");
  const failure = await readNativeHttpsStartupFailure(f.opts.configuration);
  expect(failure?.message).toContain("authority-observation: provider_busy");
  for (const error of [
    new Error("private"),
    new NativeRuntimeRequestError({
      message: "private",
      nativeCode: "private_value",
    }),
    { nativeCode: "provider_busy", message: "private" },
  ]) {
    expect(
      new NativeHttpsStartupError("frontend-start", error).diagnostic.nativeCode
    ).toBeNull();
  }
});
test("stale, foreign, malformed and symlink startup records cannot supply diagnostics", async () => {
  for (const fault of [
    "generation",
    "binding",
    "malformed",
    "extra",
    "code",
    "stage",
    "symlink",
  ] as const) {
    const f = await fixture();
    await recordNativeHttpsStartupFailure(f.opts);
    const original = await readFile(f.path, "utf8");
    if (fault === "symlink") {
      const target = join(f.home, "foreign");
      await writeFile(target, original, { mode: 0o600 });
      await rm(f.path);
      await symlink(target, f.path);
    } else if (fault === "binding") {
      await writeFile(
        f.configurationPath,
        JSON.stringify({
          ...f.opts.configuration,
          binding: { ...f.opts.configuration.binding, httpsPort: 19_444 },
        })
      );
    } else if (fault === "malformed") {
      await writeFile(f.path, "private malformed content");
    } else {
      const value = {
        version: 1,
        ownerGeneration:
          fault === "generation"
            ? "f".repeat(32)
            : f.opts.configuration.ownerGeneration,
        configurationSha256: f.opts.configurationIdentity.sha256,
        diagnostic: {
          ...f.opts.error.diagnostic,
          ...(fault === "code" ? { nativeCode: "private_code" } : {}),
          ...(fault === "stage" ? { stage: "private_stage" } : {}),
        },
        ...(fault === "extra" ? { private: "private" } : {}),
      };
      await writeFile(f.path, JSON.stringify(value));
    }
    await expect(
      readNativeHttpsStartupFailure(f.opts.configuration)
    ).rejects.toThrow("ownership");
  }
});
test("changed configuration cannot be overwritten by an old helper's diagnostic", async () => {
  const f = await fixture();
  await writeFile(
    f.configurationPath,
    JSON.stringify({ ...f.opts.configuration, ownerGeneration: "e".repeat(32) })
  );
  await expect(recordNativeHttpsStartupFailure(f.opts)).rejects.toThrow(
    "ownership"
  );
  await expect(readFile(f.path)).rejects.toThrow();
});
