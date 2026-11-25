import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import {
  createUpgradeSnapshot,
  listUpgradeSnapshots,
  readUpgradeSnapshot,
  recordUpgradeSnapshotAfter,
  restoreUpgradeSnapshot,
  type UpgradeSnapshot,
} from "../src/lib/upgrade-snapshot.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

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

test("a file published at the target after it was displaced is never overwritten, and the step's output is kept", async () => {
  // Second-family review: a replacement that landed between the last check
  // and the final rename was overwritten, and only the earlier bytes kept.
  const paths = await fixture();
  const snapshot = await snapshotOf(paths);
  await writeFile(paths.config, '{"step":true}\n');
  await writeFile(paths.created, "env: migrated\n");
  await recordUpgradeSnapshotAfter({ manifestPath: snapshot.manifestPath });
  const result = await restoreUpgradeSnapshot({
    manifestPath: snapshot.manifestPath,
    paths: [paths.config, paths.created],
    afterDisplace: async (path) => {
      await writeFile(path, `late edit of ${path}\n`);
    },
  });
  const byPath = new Map(
    result.status === "invalid-manifest"
      ? []
      : result.results.map((r) => [r.path, r])
  );
  // The late file stays; the step's output was kept before displacement.
  expect(byPath.get(paths.config)?.status).toBe("conflict");
  expect(await readFile(paths.config, "utf8")).toBe(
    `late edit of ${paths.config}\n`
  );
  expect(await readFile(byPath.get(paths.config)?.keptAs ?? "", "utf8")).toBe(
    '{"step":true}\n'
  );
  // An absent-before target: the late file is not removed, and the target
  // is not reported as restored (the snapshot holds absence).
  expect(byPath.get(paths.created)?.status).toBe("conflict");
  expect(result.status).toBe("incomplete");
  expect(await readFile(paths.created, "utf8")).toBe(
    `late edit of ${paths.created}\n`
  );
  expect(await readFile(byPath.get(paths.created)?.keptAs ?? "", "utf8")).toBe(
    "env: migrated\n"
  );
  // No sibling staging or displaced file is left behind.
  expect(
    (await readdir(join(work, "project"))).filter((name) =>
      name.includes(".hack-")
    )
  ).toEqual([]);
});

test("a late edit just before displacement goes back in place and is kept, for a created file too", async () => {
  const paths = await fixture();
  const snapshot = await snapshotOf(paths);
  await writeFile(paths.created, "env: migrated\n");
  await recordUpgradeSnapshotAfter({ manifestPath: snapshot.manifestPath });
  const result = await restoreUpgradeSnapshot({
    manifestPath: snapshot.manifestPath,
    paths: [paths.created],
    beforeReplace: async (path) => {
      await writeFile(path, "env: edited later\n");
    },
  });
  const entry =
    result.status === "invalid-manifest" ? undefined : result.results[0];
  // The late edit is linked back into place: the same file, untouched.
  expect(entry?.status).toBe("conflict");
  expect(await readFile(paths.created, "utf8")).toBe("env: edited later\n");
});

test("when the snapshot's working directories cannot be prepared, nothing is touched", async () => {
  const paths = await fixture();
  const snapshot = await snapshotOf(paths);
  await writeFile(paths.config, '{"step":true}\n');
  await recordUpgradeSnapshotAfter({ manifestPath: snapshot.manifestPath });
  // A file where the snapshot's displaced/ directory would go.
  await writeFile(join(snapshot.dir, "displaced"), "", { mode: 0o600 });
  const result = await restoreUpgradeSnapshot({
    manifestPath: snapshot.manifestPath,
    paths: [paths.config],
  });
  const entry =
    result.status === "invalid-manifest" ? undefined : result.results[0];
  expect(entry?.status).toBe("error");
  expect(await readFile(paths.config, "utf8")).toBe('{"step":true}\n');
});

test("no temporary or displaced file ever appears in the checkout", async () => {
  // Codex review: a sibling beside the target (for example
  // `..env.hack-displaced-…`) matched no ignore rule, so Git could commit
  // its secret bytes.
  const paths = await fixture();
  const snapshot = await snapshotOf(paths);
  await rm(paths.env);
  await writeFile(paths.created, "env: migrated\n");
  await recordUpgradeSnapshotAfter({ manifestPath: snapshot.manifestPath });
  const dir = join(work, "project");
  const seen: string[][] = [];
  const result = await restoreUpgradeSnapshot({
    manifestPath: snapshot.manifestPath,
    beforeReplace: async () => {
      seen.push(await readdir(dir));
    },
    afterDisplace: async () => {
      seen.push(await readdir(dir));
    },
  });
  expect(result.status).toBe("restored");
  for (const names of [...seen, await readdir(dir)]) {
    expect(
      names.filter(
        (name) => ![".env", "hack.config.json", ".hack"].includes(name)
      )
    ).toEqual([]);
  }
});

/** Runs a restore in a child process and SIGKILLs it at `boundary`. */
async function killRestoreAt(opts: {
  readonly manifestPath: string;
  readonly boundary: number;
  readonly overwrite?: boolean;
}): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures", "upgrade-restore-worker.ts"),
      opts.manifestPath,
      String(opts.boundary),
      ...(opts.overwrite === true ? ["overwrite"] : []),
    ],
    {
      cwd: root,
      env: privateCliEnv({ root, home: join(root, "home") }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const reader = child.stdout.getReader();
  try {
    const reached = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error("No restore interruption checkpoint")),
          15_000
        ).unref();
      }),
    ]);
    expect(new TextDecoder().decode(reached.value)).toContain("checkpoint");
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    reader.releaseLock();
  }
}

/** Every file kept in the snapshot's private displaced/ directory, by content. */
async function displacedContents(snapshot: UpgradeSnapshot): Promise<string[]> {
  const dir = join(snapshot.dir, "displaced");
  const names = await readdir(dir).catch(() => []);
  return (
    await Promise.all(names.map((name) => readFile(join(dir, name), "utf8")))
  ).sort();
}

test("SIGKILL at every restore boundary, then a plain rerun restores exact bytes and modes and keeps the step's output", async () => {
  // HACK-2188: a rollback killed after it moved the step's output aside and
  // before it published the snapshot's copy left the path empty, and every
  // later rollback refused it as changed unless --overwrite was passed.
  // Three targets (removed, rewritten with a new mode, created) each pass a
  // staged and a displaced boundary: six kill points.
  for (let boundary = 1; boundary <= 6; boundary += 1) {
    await rm(join(work, "project"), { recursive: true, force: true });
    const paths = await fixture();
    const envBefore = await readFile(paths.env);
    const configBefore = await readFile(paths.config);
    const snapshot = await snapshotOf(paths);
    await rm(paths.env);
    await writeFile(paths.config, '{"name":"app-a","v":5}\n');
    await chmod(paths.config, 0o600);
    await writeFile(paths.created, "env: migrated\n", { mode: 0o600 });
    await recordUpgradeSnapshotAfter({ manifestPath: snapshot.manifestPath });

    await killRestoreAt({ manifestPath: snapshot.manifestPath, boundary });

    const resumed = await restoreUpgradeSnapshot({
      manifestPath: snapshot.manifestPath,
    });
    if (resumed.status === "invalid-manifest") {
      throw new Error(resumed.message);
    }
    expect({
      boundary,
      status: resumed.status,
      results: resumed.results.map((r) => [r.label, r.status, r.message]),
    }).toMatchObject({ boundary, status: "restored" });
    expect(await readFile(paths.env)).toEqual(envBefore);
    expect(await mode(paths.env)).toBe(0o600);
    expect(await readFile(paths.config)).toEqual(configBefore);
    expect(await mode(paths.config)).toBe(0o644);
    expect(await lstat(paths.created).catch(() => null)).toBeNull();
    // Nothing is deleted: both step outputs are kept in the snapshot, and the
    // resumed target names where its displaced output is.
    expect(await displacedContents(snapshot)).toEqual([
      "env: migrated\n",
      '{"name":"app-a","v":5}\n',
    ]);
    if (boundary === 4) {
      const config = resumed.results.find((r) => r.path === paths.config);
      expect(config?.status).toBe("restored");
      expect(await readFile(config?.keptAs ?? "", "utf8")).toBe(
        '{"name":"app-a","v":5}\n'
      );
    }
    expect((await readdir(join(work, "project"))).sort()).toEqual([
      ".env",
      ".hack",
      "hack.config.json",
    ]);
    const again = await restoreUpgradeSnapshot({
      manifestPath: snapshot.manifestPath,
    });
    expect(
      again.status === "invalid-manifest"
        ? []
        : again.results.map((r) => r.status)
    ).toEqual(["already-restored", "already-restored", "already-restored"]);
    // The resumed restore is complete: a user who then deletes the restored
    // config is refused, not overridden by the step output kept aside.
    await expectDeletionKept({
      manifestPath: snapshot.manifestPath,
      path: paths.config,
    });
  }
}, 120_000);

test("a killed overwrite restore of an unrecorded target is reported where it was kept, then finished by overwrite", async () => {
  // An interrupted apply records no after state, so its rollback needs
  // overwrite. If that rollback is killed after displacement, a plain rerun
  // must not treat the displaced file as the step's output: it reports where
  // the file is and leaves the path empty; overwrite then finishes it.
  const paths = await fixture();
  const configBefore = await readFile(paths.config);
  const snapshot = await snapshotOf(paths);
  await writeFile(paths.config, '{"unrecorded":true}\n');
  // Boundaries: config staged (1), config displaced (2).
  await killRestoreAt({
    manifestPath: snapshot.manifestPath,
    boundary: 2,
    overwrite: true,
  });
  expect(await lstat(paths.config).catch(() => null)).toBeNull();
  const plain = await restoreUpgradeSnapshot({
    manifestPath: snapshot.manifestPath,
    paths: [paths.config],
  });
  const entry = plain.status === "invalid-manifest" ? null : plain.results[0];
  expect(entry?.status).toBe("conflict");
  expect(entry?.message).toContain("interrupted");
  expect(await readFile(entry?.keptAs ?? "", "utf8")).toBe(
    '{"unrecorded":true}\n'
  );
  expect(await lstat(paths.config).catch(() => null)).toBeNull();
  const forced = await restoreUpgradeSnapshot({
    manifestPath: snapshot.manifestPath,
    paths: [paths.config],
    overwrite: true,
  });
  const done = forced.status === "invalid-manifest" ? null : forced.results[0];
  expect(done?.status).toBe("restored");
  expect(await readFile(paths.config)).toEqual(configBefore);
  expect(await mode(paths.config)).toBe(0o644);
  expect(await readFile(done?.keptAs ?? "", "utf8")).toBe(
    '{"unrecorded":true}\n'
  );
}, 60_000);

/** The single result of a restore of `path` alone. */
async function restoreOne(input: {
  readonly manifestPath: string;
  readonly path: string;
  readonly overwrite?: boolean;
  readonly afterDisplace?: (path: string) => Promise<void>;
}) {
  const result = await restoreUpgradeSnapshot({
    manifestPath: input.manifestPath,
    paths: [input.path],
    overwrite: input.overwrite,
    afterDisplace: input.afterDisplace,
  });
  if (result.status === "invalid-manifest") {
    throw new Error(result.message);
  }
  const [entry] = result.results;
  if (entry === undefined) {
    throw new Error("The restore returned no result.");
  }
  return entry;
}

/** Restores the step output of the fixture's config and records it. */
async function configStepOutput() {
  const paths = await fixture();
  const configBefore = await readFile(paths.config);
  const snapshot = await snapshotOf(paths);
  await writeFile(paths.config, '{"name":"app-a","v":5}\n');
  await recordUpgradeSnapshotAfter({ manifestPath: snapshot.manifestPath });
  return { paths, configBefore, snapshot };
}

/** A plain restore of a path the user emptied is refused and stays empty. */
async function expectDeletionKept(input: {
  readonly manifestPath: string;
  readonly path: string;
}) {
  await rm(input.path);
  const plain = await restoreOne(input);
  expect(plain.status).toBe("conflict");
  expect(plain.message).not.toContain("interrupted");
  expect(plain.keptAs).toBeUndefined();
  expect(await lstat(input.path).catch(() => null)).toBeNull();
}

test("a plain rollback after the user deletes a restored file refuses it and keeps the path empty", async () => {
  // Review of HACK-2188: a completed restore left the step output keyed in
  // displaced/, so a later plain rollback took the user's deletion for an
  // interrupted restore and recreated the file without overwrite.
  const { paths, configBefore, snapshot } = await configStepOutput();
  const first = await restoreOne({
    manifestPath: snapshot.manifestPath,
    path: paths.config,
  });
  expect(first.status).toBe("restored");
  expect(await readFile(first.keptAs ?? "", "utf8")).toBe(
    '{"name":"app-a","v":5}\n'
  );
  await expectDeletionKept({
    manifestPath: snapshot.manifestPath,
    path: paths.config,
  });
  // Nothing is deleted, and overwrite still restores the snapshot's copy.
  expect(await displacedContents(snapshot)).toEqual([
    '{"name":"app-a","v":5}\n',
  ]);
  const forced = await restoreOne({
    manifestPath: snapshot.manifestPath,
    path: paths.config,
    overwrite: true,
  });
  expect(forced.status).toBe("restored");
  expect(await readFile(paths.config)).toEqual(configBefore);
});

test("a restore killed after publication, before its displaced file lost its key, is settled by the already-restored rerun", async () => {
  // The publication and the key drop are separate steps. A kill between
  // them leaves the snapshot's copy at the path and a keyed step output;
  // the rerun finds the target already restored and drops the key, so a
  // later deletion is still refused.
  const { paths, snapshot } = await configStepOutput();
  const first = await restoreOne({
    manifestPath: snapshot.manifestPath,
    path: paths.config,
  });
  const consumed = first.keptAs ?? "";
  const keyed = join(
    dirname(consumed),
    `${createHash("sha256").update(paths.config).digest("hex").slice(0, 16)}-${basename(consumed)}`
  );
  await rename(consumed, keyed);

  const again = await restoreOne({
    manifestPath: snapshot.manifestPath,
    path: paths.config,
  });
  expect(again.status).toBe("already-restored");
  expect(again.keptAs).toBeDefined();
  expect(again.keptAs).not.toBe(keyed);
  expect(await readFile(again.keptAs ?? "", "utf8")).toBe(
    '{"name":"app-a","v":5}\n'
  );
  expect(await lstat(keyed).catch(() => null)).toBeNull();
  await expectDeletionKept({
    manifestPath: snapshot.manifestPath,
    path: paths.config,
  });
});

test("a completed restore drops the key from every displaced file of its target, not only the newest", async () => {
  // A restore whose publication was refused (a file took the name) keeps
  // the step output keyed. A later overwrite restore displaces that file
  // and completes; the older step output must not be adopted after the
  // user deletes the restored file.
  const { paths, configBefore, snapshot } = await configStepOutput();
  const refused = await restoreOne({
    manifestPath: snapshot.manifestPath,
    path: paths.config,
    afterDisplace: async (path) => {
      await writeFile(path, '{"edited":true}\n');
    },
  });
  expect(refused.status).toBe("conflict");
  expect(await readFile(refused.keptAs ?? "", "utf8")).toBe(
    '{"name":"app-a","v":5}\n'
  );
  const forced = await restoreOne({
    manifestPath: snapshot.manifestPath,
    path: paths.config,
    overwrite: true,
  });
  expect(forced.status).toBe("restored");
  expect(await readFile(paths.config)).toEqual(configBefore);
  await expectDeletionKept({
    manifestPath: snapshot.manifestPath,
    path: paths.config,
  });
  expect(await displacedContents(snapshot)).toEqual([
    '{"edited":true}\n',
    '{"name":"app-a","v":5}\n',
  ]);
});

test("a parent directory reached through a symlink from another filesystem counts by where it leads", async () => {
  // Second-family review: lstat compared the symlink's own filesystem.
  const shm = "/dev/shm";
  const shmInfo = await lstat(shm).catch(() => null);
  if (shmInfo === null || shmInfo.dev === (await lstat(work)).dev) {
    return; // no second filesystem to test with on this host
  }
  const shmRoot = await mkdtemp(join(shm, "hack-upgrade-snapshot-"));
  try {
    const paths = await fixture();
    const linkedDir = join(shmRoot, "linked-project");
    await symlink(join(work, "project"), linkedDir);
    const viaLink = join(linkedDir, "hack.config.json");
    const created = await createUpgradeSnapshot({
      purpose: "symlinked parent",
      root: snapshots,
      targets: [{ path: viaLink, label: "config" }],
    });
    if (created.status !== "created") {
      throw new Error("snapshot refused");
    }
    const before = await readFile(paths.config);
    await writeFile(paths.config, '{"step":true}\n');
    await recordUpgradeSnapshotAfter({
      manifestPath: created.snapshot.manifestPath,
    });
    const result = await restoreUpgradeSnapshot({
      manifestPath: created.snapshot.manifestPath,
    });
    expect(result.status).toBe("restored");
    expect(await readFile(paths.config)).toEqual(before);
  } finally {
    await rm(shmRoot, { recursive: true, force: true });
  }
});

test("a target on another filesystem than the snapshot is refused untouched", async () => {
  const shm = "/dev/shm";
  const shmInfo = await lstat(shm).catch(() => null);
  if (shmInfo === null || shmInfo.dev === (await lstat(work)).dev) {
    return; // no second filesystem to test with on this host
  }
  const shmRoot = await mkdtemp(join(shm, "hack-upgrade-snapshot-"));
  try {
    const paths = await fixture();
    const created = await createUpgradeSnapshot({
      purpose: "cross-filesystem",
      root: join(shmRoot, "snapshots"),
      targets: [{ path: paths.config, label: "config" }],
    });
    if (created.status !== "created") {
      throw new Error("snapshot refused");
    }
    await writeFile(paths.config, '{"step":true}\n');
    await recordUpgradeSnapshotAfter({
      manifestPath: created.snapshot.manifestPath,
    });
    const result = await restoreUpgradeSnapshot({
      manifestPath: created.snapshot.manifestPath,
    });
    const entry =
      result.status === "invalid-manifest" ? undefined : result.results[0];
    expect(entry?.status).toBe("error");
    expect(entry?.message).toContain("another filesystem");
    expect(await readFile(paths.config, "utf8")).toBe('{"step":true}\n');
    // Nothing was staged or displaced beside the target.
    expect(
      (await readdir(join(work, "project"))).filter(
        (name) => name.includes(".hack-") || name.startsWith("restore-")
      )
    ).toEqual([]);
  } finally {
    await rm(shmRoot, { recursive: true, force: true });
  }
});

test("a writer holding the displaced file open keeps its edit in a named file", async () => {
  // Second-family review: copying the displaced bytes and unlinking the
  // file lost an edit made through an already-open descriptor.
  const paths = await fixture();
  const snapshot = await snapshotOf(paths);
  await writeFile(paths.config, '{"step":true}\n');
  await recordUpgradeSnapshotAfter({ manifestPath: snapshot.manifestPath });
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  const result = await restoreUpgradeSnapshot({
    manifestPath: snapshot.manifestPath,
    paths: [paths.config],
    beforeReplace: async (path) => {
      handle = await open(path, "r+");
    },
    afterDisplace: async () => {
      // The open descriptor still reaches the displaced file.
      await handle?.write('{"written":"late"}\n', 0);
      await handle?.truncate(19);
      await handle?.close();
    },
  });
  const entry =
    result.status === "invalid-manifest" ? undefined : result.results[0];
  expect(entry?.status).toBe("restored");
  expect(await readFile(paths.config, "utf8")).toBe('{"name":"app-a"}\n');
  expect(await readFile(entry?.keptAs ?? "", "utf8")).toBe(
    '{"written":"late"}\n'
  );
});

test("when the snapshot's copy cannot be published, the displaced file's location is reported", async () => {
  if (process.getuid?.() === 0) {
    return; // root writes into a read-only directory anyway
  }
  const paths = await fixture();
  const snapshot = await snapshotOf(paths);
  await writeFile(paths.config, '{"step":true}\n');
  await recordUpgradeSnapshotAfter({ manifestPath: snapshot.manifestPath });
  const dir = join(work, "project");
  let result: Awaited<ReturnType<typeof restoreUpgradeSnapshot>>;
  try {
    result = await restoreUpgradeSnapshot({
      manifestPath: snapshot.manifestPath,
      paths: [paths.config],
      afterDisplace: async () => {
        await chmod(dir, 0o500);
      },
    });
  } finally {
    await chmod(dir, 0o755);
  }
  const entry =
    result.status === "invalid-manifest" ? undefined : result.results[0];
  expect(entry?.status).toBe("error");
  // Neither published nor put back (the directory refused both): the step's
  // file is kept and named.
  expect(await readFile(entry?.keptAs ?? "", "utf8")).toBe('{"step":true}\n');
});

test("a regular file that becomes unreadable mid-restore goes back in place", async () => {
  // Codex review: a regular file that could not be read after displacement
  // was treated as a non-file and left out of place.
  if (process.getuid?.() === 0) {
    return; // root reads any file
  }
  const paths = await fixture();
  const snapshot = await snapshotOf(paths);
  await writeFile(paths.config, '{"step":true}\n');
  await recordUpgradeSnapshotAfter({ manifestPath: snapshot.manifestPath });
  const result = await restoreUpgradeSnapshot({
    manifestPath: snapshot.manifestPath,
    paths: [paths.config],
    beforeReplace: async (path) => {
      await chmod(path, 0o000);
    },
  });
  const entry =
    result.status === "invalid-manifest" ? undefined : result.results[0];
  expect(entry?.status).toBe("conflict");
  // The file is back at its path, untouched.
  await chmod(paths.config, 0o644);
  expect(await readFile(paths.config, "utf8")).toBe('{"step":true}\n');
});

test("a restore of a path the snapshot does not hold is refused, not reported as restored", async () => {
  const paths = await fixture();
  const snapshot = await snapshotOf(paths);
  await expect(
    restoreUpgradeSnapshot({
      manifestPath: snapshot.manifestPath,
      paths: [join(work, "typo.env")],
    })
  ).rejects.toThrow("not a target");
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

test("a snapshot root reached through a symlink into a Git working tree is refused", async () => {
  // Codex review: only the lexical ancestors were checked, so a symlinked
  // hack home inside a dotfiles checkout received the snapshot.
  const paths = await fixture();
  const repo = join(root, "dotfiles");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(repo, "hack-home"), { recursive: true });
  const linkedHome = join(root, "linked-hack-home");
  await symlink(join(repo, "hack-home"), linkedHome);
  const result = await createUpgradeSnapshot({
    purpose: "t",
    root: join(linkedHome, "upgrade", "snapshots"),
    targets: [{ path: paths.env, label: "env" }],
  });
  expect(
    result.status === "refused" && result.reason === "root"
      ? result.rootReason
      : null
  ).toBe("inside-working-tree");
  // Nothing was created inside the checkout.
  expect(await readdir(join(repo, "hack-home"))).toEqual([]);
});

test("Git selected through the environment refuses snapshot and restore", async () => {
  // Codex security review: GIT_DIR/GIT_WORK_TREE can make $HOME a working
  // tree with no .git marker above the snapshot root.
  const paths = await fixture();
  const ready = await snapshotOf(paths);
  await writeFile(paths.config, '{"step":true}\n');
  await recordUpgradeSnapshotAfter({ manifestPath: ready.manifestPath });
  const cases = ["GIT_DIR", "GIT_WORK_TREE"].flatMap((key) =>
    // Git takes " " as a literal path; an empty value is refused too.
    [join(root, "elsewhere"), " ", ""].map((value) => ({ key, value }))
  );
  for (const { key, value } of cases) {
    const saved = process.env[key];
    process.env[key] = value;
    try {
      const created = await createUpgradeSnapshot({
        purpose: "t",
        root: join(root, "other-snapshots"),
        targets: [{ path: paths.env, label: "env" }],
      });
      expect(
        created.status === "refused" && created.reason === "root"
          ? created.rootReason
          : null
      ).toBe("inside-working-tree");
      const restored = await restoreUpgradeSnapshot({
        manifestPath: ready.manifestPath,
      });
      expect(
        restored.status === "invalid-manifest"
          ? null
          : restored.results.find((r) => r.path === paths.config)?.status
      ).toBe("error");
      expect(await readFile(paths.config, "utf8")).toBe('{"step":true}\n');
    } finally {
      if (saved === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = saved;
      }
    }
  }
  expect(
    await lstat(join(root, "other-snapshots")).catch(() => null)
  ).toBeNull();
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
