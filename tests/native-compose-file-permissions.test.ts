import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeNativeComposeFile } from "../src/lib/native-compose-file-bytes.ts";
import {
  nativeComposeFileMode,
  nativeComposeFileModeBits,
} from "../src/lib/native-compose-file-permissions.ts";
import { assertNativeComposeFileSubset } from "../src/lib/native-compose-file-subset.ts";

test.each([
  ["0444", 0o444],
  ["0400", 0o400],
  ["0600", 0o600],
] as const)("exclusive private writer delivers exact %s permission and binary bytes", async (mode, bits) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-file-permission-"))
  );
  try {
    const path = join(root, "copy");
    const bytes = new Uint8Array([0, 255, 10]);
    const anchor = await writeNativeComposeFile({ path, bytes, mode });
    expect(anchor.mode).toBe(bits);
    expect((await lstat(path)).mode & 0o777).toBe(bits);
    expect(await readFile(path)).toEqual(Buffer.from(bytes));
    await expect(
      writeNativeComposeFile({ path, bytes, mode })
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect((await lstat(path)).ino).toBe(anchor.ino);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(
  ["0000", "0644", "0777", "400", "600", 0o400, 0o600, null, false, {}, []].map(
    (mode) => ({ mode })
  )
)("closed native permission subset refuses unsupported %j even in inactive workloads", ({
  mode,
}) => {
  expect(nativeComposeFileMode(mode)).toBeUndefined();
  expect(nativeComposeFileModeBits(mode)).toBeUndefined();
  const input = new TextEncoder().encode(
    JSON.stringify({
      schema_version: 1,
      name: "fixture",
      configs: { settings: { file: "missing" } },
      services: {
        inactive: {
          image: "fixture",
          profiles: ["later"],
          mounts: [
            {
              config: "settings",
              target: "/settings",
              access: "read-only",
              mode,
            },
          ],
        },
      },
    })
  );
  expect(() => assertNativeComposeFileSubset(input)).toThrow();
});

test("untrusted writer permission refuses before publishing a private member", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-file-invalid-permission-"))
  );
  try {
    const path = join(root, "copy");
    await expect(
      Reflect.apply(writeNativeComposeFile, undefined, [
        {
          path,
          bytes: new Uint8Array([0, 255]),
          mode: "0644",
        },
      ])
    ).rejects.toMatchObject({ code: "E_NATIVE_COMPOSE_STATE" });
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  "0444",
  "0400",
  "0600",
])("supported mode %s preserves whole-input no-build/no-UID policy", (mode) => {
  const workload = {
    image: "fixture",
    profiles: ["later"],
    mounts: [{ secret: "token", target: "/token", access: "read-only", mode }],
  };
  const input = (selected: unknown) =>
    new TextEncoder().encode(
      JSON.stringify({
        schema_version: 1,
        name: "fixture",
        secrets: { token: { file: "missing" } },
        services: { inactive: selected },
      })
    );
  expect(() => assertNativeComposeFileSubset(input(workload))).not.toThrow();
  expect(() =>
    assertNativeComposeFileSubset(
      input({ ...workload, build: { context: "." } })
    )
  ).toThrow();
  for (const extra of [{ uid: 0 }, { gid: 0 }, { access: "read-write" }]) {
    expect(() =>
      assertNativeComposeFileSubset(
        input({ ...workload, mounts: [{ ...workload.mounts[0], ...extra }] })
      )
    ).toThrow();
  }
});
