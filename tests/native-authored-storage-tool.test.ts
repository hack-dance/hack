import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageNativeStorageTool } from "../scripts/package-native-storage-tool.ts";
import {
  NATIVE_STORAGE_TOOL_FILE,
  NATIVE_STORAGE_TOOL_MANIFEST,
  nativeAuthoredStorageToolRequired,
  nativeStorageToolManifest,
  parseNativeStorageToolManifest,
  resolveNativeAuthoredStorageTool,
} from "../src/backends/native-authored-storage-tool.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-storage-tool-"));
  roots.push(root);
  await chmod(root, 0o700);
  const bytes = Buffer.alloc(128);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  bytes.writeUInt16LE(183, 18);
  const tool = join(root, NATIVE_STORAGE_TOOL_FILE);
  const manifest = join(root, NATIVE_STORAGE_TOOL_MANIFEST);
  await writeFile(tool, bytes, { mode: 0o500 });
  await packageNativeStorageTool({
    directory: root,
    sourceRevision: "a".repeat(40),
  });
  return { root, bytes, tool, manifest, binary: join(root, "hack-native") };
}

test("packaged byte contract resolves the explicit bundle and closes held admission", async () => {
  const f = await fixture();
  const selection = await resolveNativeAuthoredStorageTool(f.binary);
  try {
    expect(selection.path).toBe(f.tool);
    expect(selection.digest).toBe(
      nativeStorageToolManifest(f.bytes, "a".repeat(40)).sha256
    );
    expect(Object.isFrozen(selection)).toBe(true);
    await selection.assertFresh();
  } finally {
    await selection.close();
  }
  await expect(selection.assertFresh()).rejects.toThrow("Values omitted");
  await selection.close();
});

test("only selected service or job storage mounts require a bundle", () => {
  expect(
    nativeAuthoredStorageToolRequired({
      storage: { unused: {} },
      services: { web: { mounts: [{ source: "src" }] } },
    })
  ).toBe(false);
  for (const group of ["services", "jobs"]) {
    expect(
      nativeAuthoredStorageToolRequired({
        [group]: {
          selected: {
            mounts: [{ storage: "db", target: "/data", access: "read_write" }],
          },
        },
      })
    ).toBe(true);
  }
});

test.each([
  "sha256",
  "bytes",
  "architecture",
  "sourceRevision",
  "extra",
] as const)("closed manifest refuses changed %s", async (field) => {
  const f = await fixture();
  const value: Record<string, unknown> = {
    ...parseNativeStorageToolManifest(
      JSON.parse(await readFile(f.manifest, "utf8"))
    ),
  };
  value[field] = {
    sha256: "b".repeat(64),
    bytes: 129,
    architecture: "amd64",
    sourceRevision: "bad",
    extra: true,
  }[field];
  await writeFile(f.manifest, JSON.stringify(value));
  await expect(resolveNativeAuthoredStorageTool(f.binary)).rejects.toThrow(
    "Values omitted"
  );
});

test.each([
  "tool",
  "manifest",
] as const)("same-byte %s replacement invalidates captured incarnation", async (field) => {
  const f = await fixture();
  const selection = await resolveNativeAuthoredStorageTool(f.binary);
  try {
    const path = f[field];
    const bytes = await readFile(path);
    await rename(path, `${path}.original`);
    await writeFile(path, bytes, { mode: field === "tool" ? 0o500 : 0o600 });
    await expect(selection.assertFresh()).rejects.toThrow("Values omitted");
  } finally {
    await selection.close();
  }
});

test.each([
  "hardlink",
  "symlink",
  "writable",
  "not-executable",
  "wrong-ELF",
  "changed-bytes",
])("artifact refuses %s without executing it", async (mode) => {
  const f = await fixture();
  if (mode === "hardlink") {
    await link(f.tool, join(f.root, "alias"));
  } else if (mode === "symlink") {
    await rename(f.tool, `${f.tool}.original`);
    await symlink(`${f.tool}.original`, f.tool);
  } else if (mode === "writable" || mode === "not-executable") {
    await chmod(f.tool, mode === "writable" ? 0o520 : 0o400);
  } else {
    await chmod(f.tool, 0o700);
    const bytes = Buffer.from(f.bytes);
    bytes[mode === "wrong-ELF" ? 18 : 127] = 0;
    if (mode === "changed-bytes") {
      bytes[127] = 1;
    }
    await writeFile(f.tool, bytes);
    await chmod(f.tool, 0o500);
    if (mode === "wrong-ELF") {
      const manifest = {
        ...parseNativeStorageToolManifest(
          JSON.parse(await readFile(f.manifest, "utf8"))
        ),
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      };
      await writeFile(f.manifest, JSON.stringify(manifest));
    }
  }
  await expect(resolveNativeAuthoredStorageTool(f.binary)).rejects.toThrow(
    "Values omitted"
  );
});

test("manifest packaging never replaces an existing leaf", async () => {
  const f = await fixture();
  const bytes = await readFile(f.manifest);
  await expect(
    packageNativeStorageTool({
      directory: f.root,
      sourceRevision: "b".repeat(40),
    })
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(f.manifest)).toEqual(bytes);
  expect(() => parseNativeStorageToolManifest({})).toThrow("Values omitted");
});
