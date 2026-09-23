import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { packageMcpBundle, verifyMcpBundle } from "../src/mcp/bundle.ts";

const roots: string[] = [];
async function writableDirectories(path: string): Promise<void> {
  if (!(await lstat(path)).isDirectory()) {
    return;
  }
  await chmod(path, 0o700);
  for (const name of await readdir(path)) {
    await writableDirectories(join(path, name));
  }
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await writableDirectories(root);
    await rm(root, { recursive: true, force: true });
  }
});

async function executable(
  path: string,
  role: string,
  extra: Record<string, unknown> = {}
) {
  const info = {
    schemaVersion: 1,
    role,
    startupProtocol: 2,
    wireProtocol: 1,
    platform: process.platform,
    architecture: process.arch,
    ...extra,
  };
  const quoted = JSON.stringify(info).replaceAll("'", "'\\''");
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${quoted}'\n`, {
    mode: 0o700,
  });
}

async function fixture() {
  const root = await mkdtemp("/tmp/hack-bundle-");
  roots.push(root);
  const inputRoot = join(root, "inputs");
  await mkdir(inputRoot, { mode: 0o700 });
  const inputs = {
    adapter: join(inputRoot, "adapter"),
    owner: join(inputRoot, "owner"),
    backend: join(inputRoot, "backend"),
  };
  for (const role of ["adapter", "owner", "backend"] as const) {
    await executable(inputs[role], role);
  }
  return { root, inputs, outputRoot: join(root, "bundles") };
}

test("packaging publishes one content identity and concurrent identical writers reuse it", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([packageMcpBundle(f), packageMcpBundle(f)]);
  expect(a.directory).toBe(b.directory);
  expect(a.manifest.bundleId).toMatch(/^[a-f0-9]{64}$/);
  expect(await readdir(f.outputRoot)).toEqual([a.manifest.bundleId]);
  const before = await lstat(join(a.directory, "manifest.json"));
  expect((await verifyMcpBundle({ directory: a.directory })).manifest).toEqual(
    a.manifest
  );
  await packageMcpBundle(f);
  expect((await lstat(join(a.directory, "manifest.json"))).ino).toBe(
    before.ino
  );
  for (const path of Object.values(a.executables)) {
    expect((await lstat(path)).mode & 0o777).toBe(0o500);
  }
}, 15_000);

test("failed artifact probes preserve the previous valid bundle and remove owned staging", async () => {
  const f = await fixture();
  const first = await packageMcpBundle(f);
  await executable(f.inputs.owner, "adapter");
  await expect(packageMcpBundle(f)).rejects.toThrow("role or host");
  expect(await readdir(f.outputRoot)).toEqual([first.manifest.bundleId]);
  expect(
    (await verifyMcpBundle({ directory: first.directory })).manifest
  ).toEqual(first.manifest);
});

test("substituted asset fails hashing and is not silently overwritten by repackaging", async () => {
  const f = await fixture();
  const bundle = await packageMcpBundle(f);
  await chmod(bundle.executables.owner, 0o700);
  await writeFile(bundle.executables.owner, "changed executable");
  await chmod(bundle.executables.owner, 0o500);
  await expect(
    verifyMcpBundle({ directory: bundle.directory })
  ).rejects.toThrow("integrity check");
  await expect(packageMcpBundle(f)).rejects.toThrow("integrity check");
  expect(await readFile(bundle.executables.owner, "utf8")).toBe(
    "changed executable"
  );
  expect(await readdir(f.outputRoot)).toEqual([bundle.manifest.bundleId]);
});

for (const mutation of [
  "platform",
  "protocol",
  "missing",
  "symlink",
  "hardlink",
] as const) {
  test(`verification refuses ${mutation} mismatch`, async () => {
    const f = await fixture();
    const bundle = await packageMcpBundle(f);
    await chmod(bundle.directory, 0o700);
    if (mutation === "platform" || mutation === "protocol") {
      const manifest = {
        ...bundle.manifest,
        ...(mutation === "platform"
          ? { platform: process.platform === "darwin" ? "linux" : "darwin" }
          : { startupProtocol: 1 }),
      };
      const path = join(bundle.directory, "manifest.json");
      await chmod(path, 0o600);
      await writeFile(path, JSON.stringify(manifest));
      await chmod(path, 0o400);
    } else if (mutation === "hardlink") {
      await link(bundle.executables.adapter, join(f.root, "alias"));
    } else {
      await rm(bundle.executables.adapter);
      if (mutation === "symlink") {
        await symlink(f.inputs.adapter, bundle.executables.adapter);
      }
    }
    await expect(
      verifyMcpBundle({ directory: bundle.directory })
    ).rejects.toThrow();
  });
}

test("over-budget capability output is refused without exposing its bytes", async () => {
  const f = await fixture();
  await writeFile(
    f.inputs.owner,
    `#!/bin/sh\nprintf '%s' '${"private-synthetic".repeat(1000)}'\n`
  );
  await expect(packageMcpBundle(f)).rejects.toThrow("capability probe failed");
  expect(await readdir(f.outputRoot)).toEqual([]);
});

test("a hanging capability probe is killed and its staging is removed", async () => {
  const f = await fixture();
  await writeFile(f.inputs.owner, "#!/bin/sh\nexec /bin/sleep 30\n");
  const start = Date.now();
  await expect(packageMcpBundle(f)).rejects.toThrow("capability probe failed");
  expect(Date.now() - start).toBeGreaterThanOrEqual(4500);
  expect(Date.now() - start).toBeLessThan(9000);
  expect(await readdir(f.outputRoot)).toEqual([]);
}, 10_000);
