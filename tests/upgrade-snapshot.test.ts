import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createUpgradeSnapshot,
  listUpgradeSnapshots,
  readUpgradeSnapshot,
  recordUpgradeSnapshotAfter,
  restoreUpgradeSnapshot,
  type UpgradeSnapshot,
} from "../src/lib/upgrade-snapshot.ts";

// A value that must never appear in a manifest, result or message.
const SENTINEL = ["sentinel", "upgrade", "value", "7f3a91"].join("-");

let root = "";
let work = "";
let snapshots = "";

beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-upgrade-snapshot-"))
  );
  work = join(root, "work");
  snapshots = join(root, "private", "snapshots");
  await mkdir(work, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const env = join(work, "project", ".env");
  const config = join(work, "project", "hack.config.json");
  const created = join(work, "project", ".hack", "env.yaml");
  await mkdir(join(work, "project", ".hack"), { recursive: true });
  await writeFile(env, `TOKEN=${SENTINEL}\n`, { mode: 0o600 });
  await chmod(env, 0o600);
  await writeFile(config, '{"name":"app-a"}\n', { mode: 0o644 });
  await chmod(config, 0o644);
  return { env, config, created };
}

async function snapshotOf(paths: {
  env: string;
  config: string;
  created: string;
}) {
  const created = await createUpgradeSnapshot({
    purpose: "env-migration app-a",
    root: snapshots,
    targets: [
      { path: paths.env, label: "project app-a: .env" },
      { path: paths.config, label: "project app-a: hack.config.json" },
      { path: paths.created, label: "project app-a: .hack/env.yaml" },
    ],
    now: new Date("2026-11-13T12:00:00Z"),
  });
  if (created.status !== "created") {
    throw new Error(`snapshot refused: ${JSON.stringify(created)}`);
  }
  return created.snapshot;
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o7777;
}

test("snapshot, mutate, delete and create, then restore puts back exact bytes and modes", async () => {
  const paths = await fixture();
  const envBefore = await readFile(paths.env);
  const configBefore = await readFile(paths.config);
  const snapshot = await snapshotOf(paths);

  // The step: delete .env, rewrite the config (and its mode), create a file.
  await rm(paths.env);
  await writeFile(paths.config, '{"name":"app-a","v":5}\n');
  await chmod(paths.config, 0o600);
  await writeFile(paths.created, "env: migrated\n", { mode: 0o600 });
  const recorded = await recordUpgradeSnapshotAfter({
    manifestPath: snapshot.manifestPath,
  });
  expect(recorded.status).toBe("recorded");

  const restored = await restoreUpgradeSnapshot({
    manifestPath: snapshot.manifestPath,
  });
  expect(restored.status).toBe("restored");
  expect(
    Object.fromEntries(
      restored.status === "invalid-manifest"
        ? []
        : restored.results.map((r) => [r.label, r.status])
    )
  ).toEqual({
    "project app-a: .env": "restored",
    "project app-a: hack.config.json": "restored",
    "project app-a: .hack/env.yaml": "moved-aside",
  });
  expect(await readFile(paths.env)).toEqual(envBefore);
  expect(await mode(paths.env)).toBe(0o600);
  expect(await readFile(paths.config)).toEqual(configBefore);
  expect(await mode(paths.config)).toBe(0o644);
  // The created file is gone from its path but kept, never deleted.
  expect(await lstat(paths.created).catch(() => null)).toBeNull();
  const moved =
    restored.status === "invalid-manifest"
      ? undefined
      : restored.results.find((r) => r.status === "moved-aside");
  expect(moved?.keptAs).toBeDefined();
  expect(await readFile(moved?.keptAs ?? "", "utf8")).toBe("env: migrated\n");
  // The replaced config is kept too.
  const replaced =
    restored.status === "invalid-manifest"
      ? undefined
      : restored.results.find((r) => r.label.endsWith("hack.config.json"));
  expect(await readFile(replaced?.keptAs ?? "", "utf8")).toBe(
    '{"name":"app-a","v":5}\n'
  );

  // Idempotent: a second restore changes nothing.
  const again = await restoreUpgradeSnapshot({
    manifestPath: snapshot.manifestPath,
  });
  expect(again.status).toBe("restored");
  expect(
    again.status === "invalid-manifest"
      ? []
      : again.results.map((r) => r.status)
  ).toEqual(["already-restored", "already-restored", "already-restored"]);
});

test("a target changed since the step recorded it is refused, and kept when overwritten", async () => {
  const paths = await fixture();
  const envBefore = await readFile(paths.env);
  const snapshot = await snapshotOf(paths);
  await writeFile(paths.env, "TOKEN=written-by-step\n");
  await recordUpgradeSnapshotAfter({ manifestPath: snapshot.manifestPath });
  // A later edit, after the step.
  await writeFile(paths.env, "TOKEN=edited-later\n");

  const refused = await restoreUpgradeSnapshot({
    manifestPath: snapshot.manifestPath,
    paths: [paths.env],
  });
  expect(refused.status).toBe("incomplete");
  const entry =
    refused.status === "invalid-manifest" ? undefined : refused.results[0];
  expect(entry?.status).toBe("conflict");
  expect(entry?.message).toContain("changed since the upgrade step wrote it");
  expect(await readFile(paths.env, "utf8")).toBe("TOKEN=edited-later\n");

  const forced = await restoreUpgradeSnapshot({
    manifestPath: snapshot.manifestPath,
    paths: [paths.env],
    overwrite: true,
  });
  const done =
    forced.status === "invalid-manifest" ? undefined : forced.results[0];
  expect(done?.status).toBe("restored");
  expect(await readFile(paths.env)).toEqual(envBefore);
  expect(await readFile(done?.keptAs ?? "", "utf8")).toBe(
    "TOKEN=edited-later\n"
  );
});

test("without a recorded after state, a changed target needs overwrite", async () => {
  const paths = await fixture();
  const snapshot = await snapshotOf(paths);
  await writeFile(paths.config, "{}\n");
  const refused = await restoreUpgradeSnapshot({
    manifestPath: snapshot.manifestPath,
    paths: [paths.config],
  });
  const entry =
    refused.status === "invalid-manifest" ? undefined : refused.results[0];
  expect(entry?.status).toBe("conflict");
  expect(entry?.message).toContain("did not record what it wrote");
  expect(await readFile(paths.config, "utf8")).toBe("{}\n");
});

test("a target changed during the restore is left as it is", async () => {
  const paths = await fixture();
  const snapshot = await snapshotOf(paths);
  await writeFile(paths.config, '{"step":true}\n');
  await recordUpgradeSnapshotAfter({ manifestPath: snapshot.manifestPath });
  const result = await restoreUpgradeSnapshot({
    manifestPath: snapshot.manifestPath,
    paths: [paths.config],
    beforeReplace: async (path) => {
      await writeFile(path, '{"racing":true}\n');
    },
  });
  const entry =
    result.status === "invalid-manifest" ? undefined : result.results[0];
  expect(entry?.status).toBe("conflict");
  expect(await readFile(paths.config, "utf8")).toBe('{"racing":true}\n');
});

test("no value reaches the manifest, the results or the messages; storage is private", async () => {
  const paths = await fixture();
  const snapshot = await snapshotOf(paths);
  await rm(paths.env);
  await recordUpgradeSnapshotAfter({ manifestPath: snapshot.manifestPath });
  const restored = await restoreUpgradeSnapshot({
    manifestPath: snapshot.manifestPath,
  });
  const manifestText = await readFile(snapshot.manifestPath, "utf8");
  expect(manifestText).not.toContain(SENTINEL);
  expect(JSON.stringify(snapshot)).not.toContain(SENTINEL);
  expect(JSON.stringify(restored)).not.toContain(SENTINEL);
  expect(
    JSON.stringify(await listUpgradeSnapshots({ root: snapshots }))
  ).not.toContain(SENTINEL);
  // The bytes are kept only in private blobs.
  expect(await mode(snapshots)).toBe(0o700);
  expect(await mode(snapshot.dir)).toBe(0o700);
  expect(await mode(join(snapshot.dir, "blobs"))).toBe(0o700);
  expect(await mode(snapshot.manifestPath)).toBe(0o600);
  for (const name of await readdir(join(snapshot.dir, "blobs"))) {
    expect(await mode(join(snapshot.dir, "blobs", name))).toBe(0o600);
  }
});

test("a target that cannot be snapshotted refuses the whole snapshot and writes nothing", async () => {
  const paths = await fixture();
  const linked = join(work, "project", "linked.env");
  await symlink(paths.env, linked);
  const directory = join(work, "project", ".hack");
  for (const targets of [
    [{ path: linked, label: "link" }],
    [{ path: directory, label: "dir" }],
    [{ path: "relative/.env", label: "relative" }],
    [
      { path: paths.env, label: "a" },
      { path: paths.env, label: "b" },
    ],
    [{ path: join(snapshots, "x"), label: "inside" }],
  ]) {
    const result = await createUpgradeSnapshot({
      purpose: "t",
      root: snapshots,
      targets: [{ path: paths.config, label: "ok" }, ...targets],
    });
    expect(result.status).toBe("refused");
  }
  expect(await lstat(snapshots).catch(() => null)).toBeNull();
});

test("a snapshot root inside a Git working tree is refused", async () => {
  const paths = await fixture();
  const repo = join(root, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  const result = await createUpgradeSnapshot({
    purpose: "t",
    root: join(repo, "snapshots"),
    targets: [{ path: paths.env, label: "env" }],
  });
  expect(result.status === "refused" && result.reason === "root").toBe(true);
  expect(
    result.status === "refused" && result.reason === "root"
      ? result.rootReason
      : null
  ).toBe("inside-working-tree");
});

test("a manifest that is not private, or a damaged copy, restores nothing", async () => {
  const paths = await fixture();
  const envBefore = await readFile(paths.env);
  const snapshot: UpgradeSnapshot = await snapshotOf(paths);
  await writeFile(paths.env, "TOKEN=step\n");
  await recordUpgradeSnapshotAfter({ manifestPath: snapshot.manifestPath });

  await chmod(snapshot.manifestPath, 0o644);
  expect(
    (await readUpgradeSnapshot({ manifestPath: snapshot.manifestPath })).status
  ).toBe("invalid");
  expect(
    (await restoreUpgradeSnapshot({ manifestPath: snapshot.manifestPath }))
      .status
  ).toBe("invalid-manifest");
  await chmod(snapshot.manifestPath, 0o600);

  // Damage the kept copy of .env: its digest no longer matches.
  const entry = snapshot.manifest.entries.find((e) => e.path === paths.env);
  const digest = entry?.before.kind === "file" ? entry.before.sha256 : "";
  await writeFile(join(snapshot.dir, "blobs", digest), "damaged\n", {
    mode: 0o600,
  });
  const result = await restoreUpgradeSnapshot({
    manifestPath: snapshot.manifestPath,
    paths: [paths.env],
  });
  expect(
    result.status === "invalid-manifest" ? null : result.results[0]?.status
  ).toBe("backup-damaged");
  expect(await readFile(paths.env, "utf8")).toBe("TOKEN=step\n");
  expect(envBefore.toString()).toContain(SENTINEL);
});
