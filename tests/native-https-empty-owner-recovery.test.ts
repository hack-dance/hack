import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveEmptyNativeHttpsOwner,
  type EmptyNativeHttpsOwnerInspection,
  type EmptyNativeHttpsOwnerSelection,
} from "../src/backends/native-https-empty-owner-recovery.ts";
import { ensureNativeHttpsOwner } from "../src/backends/native-https-owner.ts";
import {
  acquireNativeHttpsOwnerAdmission,
  NATIVE_HTTPS_OWNER_ADMISSION,
} from "../src/backends/native-https-owner-admission.ts";
import type { NativeHttpsOwnerConfiguration } from "../src/backends/native-https-owner-protocol.ts";
import { nativeHttpsWriteNew } from "../src/backends/native-https-owner-storage.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});
const sha = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const absent = async (path: string) =>
  await lstat(path)
    .then(() => false)
    .catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return true;
      }
      throw error;
    });

async function fixture() {
  const home = await mkdtemp(join(await realpath(tmpdir()), "hk-empty-owner-"));
  homes.push(home);
  await chmod(home, 0o700);
  const storage = join(home, "native-https");
  const root = join(storage, "shared-owner");
  await mkdir(join(root, "leases"), { recursive: true, mode: 0o700 });
  await chmod(storage, 0o700);
  await chmod(root, 0o700);
  await chmod(join(root, "leases"), 0o700);
  const sibling = join(storage, "data", "caddy", "marker");
  await mkdir(join(storage, "data", "caddy"), { recursive: true, mode: 0o700 });
  await writeFile(sibling, "retained sibling data", { mode: 0o600 });
  const binary = join(home, "reviewed-binary");
  await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const binarySha = sha(await readFile(binary));
  const config: NativeHttpsOwnerConfiguration = {
    version: 1,
    ownerGeneration: "a".repeat(32),
    binding: {
      runtime: { home, binary },
      runtimeSha256: binarySha,
      frontend: { binary, sha256: binarySha },
      pool: {
        owner: "b".repeat(32),
        bootId: "12345678-1234-1234-1234-123456789abc",
      },
      caddyBinary: binary,
      caddySha256: binarySha,
      httpsPort: 18_443,
      certificateNameLimit: 16,
    },
  };
  const configPath = join(root, "configuration.json");
  const bytes = `${JSON.stringify(config)}\n`;
  await writeFile(configPath, bytes, { mode: 0o600 });
  const selection: EmptyNativeHttpsOwnerSelection = {
    ownerGeneration: config.ownerGeneration,
    configurationSha256: sha(bytes),
    runtime: config.binding.runtime,
    runtimeSha256: config.binding.runtimeSha256,
    originalSpawnerPid: 47_321,
  };
  const inspection: EmptyNativeHttpsOwnerInspection = {
    originalSpawnerAbsent: async () => true,
    selectedOwnerProcessAbsent: async () => true,
    selectedPortAbsent: async () => true,
    poolAndPublications: async () => true,
  };
  return {
    home,
    storage,
    root,
    configPath,
    config,
    bytes,
    selection,
    inspection,
    sibling,
  };
}
async function archive(f: Awaited<ReturnType<typeof fixture>>) {
  return archiveEmptyNativeHttpsOwner({
    selection: f.selection,
    acceptLegacyOwnerWithoutPid: true,
    inspection: f.inspection,
  });
}

test("archives exact empty owner, retaining its inode, bytes, and sibling data", async () => {
  const f = await fixture();
  const before = await lstat(f.root);
  const result = await archive(f);
  const after = await lstat(result.archive);
  expect(after.dev).toBe(before.dev);
  expect(after.ino).toBe(before.ino);
  expect(
    await readFile(join(result.archive, "configuration.json"), "utf8")
  ).toBe(f.bytes);
  expect(await readdir(join(result.archive, "leases"))).toEqual([]);
  expect(await readFile(f.sibling, "utf8")).toBe("retained sibling data");
  expect(await absent(f.root)).toBe(true);
  expect(await absent(join(f.storage, "owner.lock"))).toBe(true);
  expect(await absent(join(f.storage, NATIVE_HTTPS_OWNER_ADMISSION))).toBe(
    true
  );
  const entries = await readdir(f.storage);
  expect(
    entries.filter((value) => value.includes("empty-owner-recovery-"))
  ).toHaveLength(2);
  expect(
    await archive(f)
      .then(() => true)
      .catch(() => false)
  ).toBe(false);
});

test.each([
  "originalSpawnerAbsent",
  "selectedOwnerProcessAbsent",
  "selectedPortAbsent",
  "poolAndPublications",
] as const)("refuses uncertain or live %s without moving selected state", async (method) => {
  const f = await fixture();
  f.inspection[method] = async () => false;
  await expect(archive(f)).rejects.toThrow();
  expect(await readFile(f.configPath, "utf8")).toBe(f.bytes);
  expect(await absent(join(f.storage, "owner.lock"))).toBe(true);
  expect(await absent(join(f.storage, NATIVE_HTTPS_OWNER_ADMISSION))).toBe(
    true
  );
});

test.each([
  ["endpoint.json", "root"],
  ["configuration.pending", "root"],
  ["unknown", "root"],
  ["lease.json", "leases"],
  ["owner.sock", "storage"],
  ["active-owner.json", "storage"],
  ["owner.lock", "storage"],
  ["empty-owner-recovery-foreign.pending", "storage"],
  ["archived-empty-owner-foreign", "storage"],
] as const)("refuses %s at %s while retaining exact selected state", async (name, where) => {
  const f = await fixture();
  const parent =
    where === "root"
      ? f.root
      : where === "leases"
        ? join(f.root, "leases")
        : f.storage;
  if (name === "owner.lock") {
    await mkdir(join(parent, name), { mode: 0o700 });
  } else {
    await writeFile(join(parent, name), "foreign", { mode: 0o600 });
  }
  await expect(archive(f)).rejects.toThrow();
  expect(await readFile(f.configPath, "utf8")).toBe(f.bytes);
  expect(
    await readFile(join(parent, name), "utf8").catch(() => "directory")
  ).toBe(name === "owner.lock" ? "directory" : "foreign");
});

test("requires exact acknowledgement, selected digest, generation, and runtime", async () => {
  const f = await fixture();
  await expect(
    archiveEmptyNativeHttpsOwner({
      selection: f.selection,
      acceptLegacyOwnerWithoutPid: false as true,
      inspection: f.inspection,
    })
  ).rejects.toThrow();
  for (const selection of [
    { ...f.selection, configurationSha256: "0".repeat(64) },
    { ...f.selection, ownerGeneration: "0".repeat(32) },
    { ...f.selection, runtimeSha256: "0".repeat(64) },
    { ...f.selection, runtime: { ...f.selection.runtime, home: f.storage } },
    { ...f.selection, originalSpawnerPid: 0 },
  ]) {
    await expect(
      archiveEmptyNativeHttpsOwner({
        selection,
        acceptLegacyOwnerWithoutPid: true,
        inspection: f.inspection,
      })
    ).rejects.toThrow();
  }
  expect(await readFile(f.configPath, "utf8")).toBe(f.bytes);
});

test("identity drift immediately before rename refuses and preserves both names", async () => {
  const f = await fixture();
  let inspections = 0;
  f.inspection.selectedPortAbsent = async () => {
    inspections++;
    if (inspections === 2) {
      await writeFile(f.configPath, "replacement", { mode: 0o600 });
    }
    return true;
  };
  await expect(archive(f)).rejects.toThrow();
  expect(await readFile(f.configPath, "utf8")).toBe("replacement");
  expect(await absent(f.root)).toBe(false);
  expect(await absent(join(f.storage, "owner.lock"))).toBe(true);
});

test("failure after durable intent preserves pending proof and exclusion locks", async () => {
  const f = await fixture();
  let inspections = 0;
  f.inspection.selectedPortAbsent = async () => {
    inspections++;
    return inspections < 3;
  };
  await expect(archive(f)).rejects.toThrow();
  expect(await readFile(f.configPath, "utf8")).toBe(f.bytes);
  expect(await absent(join(f.storage, "owner.lock"))).toBe(false);
  expect(await absent(join(f.storage, NATIVE_HTTPS_OWNER_ADMISSION))).toBe(
    false
  );
  expect(
    (await readdir(f.storage)).some((name) => name.endsWith(".intent.json"))
  ).toBe(true);
  await expect(archive(f)).rejects.toThrow();
});

test("normal concurrent ensures publish and share one generation", async () => {
  const f = await fixture();
  await rm(f.root, { recursive: true });
  let spawns = 0;
  const options = {
    binding: f.config.binding,
    spawnOwner: async () => {
      spawns++;
      await Bun.sleep(30);
    },
  };
  const [first, second] = await Promise.all([
    ensureNativeHttpsOwner(options),
    ensureNativeHttpsOwner(options),
  ]);
  expect(first).toEqual(second);
  expect(spawns).toBe(1);
  expect(await absent(join(f.storage, NATIVE_HTTPS_OWNER_ADMISSION))).toBe(
    true
  );
});

test("archival admission blocks a concurrent ensure until complete proof and lock retirement", async () => {
  const f = await fixture();
  let finishComplete: (() => void) | undefined;
  let enteredComplete: (() => void) | undefined;
  const atComplete = new Promise<void>((resolve) => {
    enteredComplete = resolve;
  });
  const holdComplete = new Promise<void>((resolve) => {
    finishComplete = resolve;
  });
  const recovering = archiveEmptyNativeHttpsOwner({
    selection: f.selection,
    acceptLegacyOwnerWithoutPid: true,
    inspection: f.inspection,
    writeJournal: async (path, value) => {
      if (path.endsWith(".complete.json")) {
        enteredComplete?.();
        await holdComplete;
      }
      return nativeHttpsWriteNew(path, value);
    },
  });
  await atComplete;
  let spawns = 0;
  const ensuring = ensureNativeHttpsOwner({
    binding: f.config.binding,
    spawnOwner: async () => {
      spawns++;
    },
  });
  await Bun.sleep(50);
  expect(spawns).toBe(0);
  expect(await absent(f.root)).toBe(true);
  finishComplete?.();
  const archived = await recovering;
  const replacement = await ensuring;
  expect(spawns).toBe(1);
  expect(replacement.ownerGeneration).not.toBe(f.selection.ownerGeneration);
  expect(
    await readFile(join(archived.archive, "configuration.json"), "utf8")
  ).toBe(f.bytes);
  expect(await absent(join(f.storage, NATIVE_HTTPS_OWNER_ADMISSION))).toBe(
    true
  );
});

test("uncertain failure after intent publication retains admission and HTTPS barriers", async () => {
  const f = await fixture();
  await expect(
    archiveEmptyNativeHttpsOwner({
      selection: f.selection,
      acceptLegacyOwnerWithoutPid: true,
      inspection: f.inspection,
      writeJournal: async (path, value) => {
        const published = await nativeHttpsWriteNew(path, value);
        if (path.endsWith(".intent.json")) {
          throw new Error("injected post-publication fsync failure");
        }
        return published;
      },
    })
  ).rejects.toThrow("injected post-publication fsync failure");
  expect(await absent(f.root)).toBe(false);
  expect(await absent(join(f.storage, "owner.lock"))).toBe(false);
  expect(await absent(join(f.storage, NATIVE_HTTPS_OWNER_ADMISSION))).toBe(
    false
  );
  expect(
    (await readdir(f.storage)).some((name) => name.endsWith(".intent.json"))
  ).toBe(true);
  await expect(
    acquireNativeHttpsOwnerAdmission({ home: f.home, waitMs: 0 })
  ).rejects.toThrow();
});

test("a replacement appearing after rename is retained and success is refused", async () => {
  const f = await fixture();
  const foreign = "foreign replacement";
  await expect(
    archiveEmptyNativeHttpsOwner({
      selection: f.selection,
      acceptLegacyOwnerWithoutPid: true,
      inspection: f.inspection,
      writeJournal: async (path, value) => {
        if (path.endsWith(".complete.json")) {
          await mkdir(f.root, { mode: 0o700 });
          await writeFile(join(f.root, "foreign"), foreign, { mode: 0o600 });
        }
        return nativeHttpsWriteNew(path, value);
      },
    })
  ).rejects.toThrow();
  expect(await readFile(join(f.root, "foreign"), "utf8")).toBe(foreign);
  expect(
    (await readdir(f.storage)).some((name) =>
      name.startsWith("archived-empty-owner-")
    )
  ).toBe(true);
  expect(await absent(join(f.storage, NATIVE_HTTPS_OWNER_ADMISSION))).toBe(
    false
  );
});
