import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  cp,
  link,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNativeAuthoredReceipt } from "../src/backends/native-authored-graph-protocol.ts";
import {
  loadNativeAuthoredProjectRun as load,
  prepareNativeAuthoredProjectRunStorage as prepare,
  removeNativeAuthoredProjectRun as remove,
  saveNativeAuthoredProjectRun as save,
} from "../src/backends/native-authored-project-run.ts";
import {
  loadNativeProjectRun as loadCompose,
  saveNativeProjectRun as saveCompose,
} from "../src/backends/native-project-run.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
function receipt(run = "a".repeat(32)) {
  const provenance = {
    version: 1,
    kind: "native",
    namespace: "b".repeat(64),
    run,
    input: {
      semantic_hash: "c".repeat(64),
      local_resolution_hash: "d".repeat(64),
      environment_policy_hash: "e".repeat(64),
      selected_profiles: [],
    },
  };
  return {
    version: 2,
    kind: "native-graph-runtime",
    owner: "f".repeat(32),
    boot: "00000000-0000-0000-0000-000000000001",
    review: {
      provenance,
      review_id: createHash("sha256")
        .update("hack.native-graph-review/v1\0")
        .update(JSON.stringify(provenance))
        .digest("hex"),
    },
    phase: "ready-observed",
    readiness: { web: "healthy" },
    resources: {
      "network:default": {
        kind: "network",
        key: "default",
        name: `hkn-${run}-network-0`,
        id: "1".repeat(64),
        image: null,
        phase: "created",
        outbound: true,
      },
      "container:web": {
        kind: "container",
        key: "web",
        name: `hkn-${run}-container-0`,
        id: "2".repeat(64),
        image: `sha256:${"3".repeat(64)}`,
        phase: "started",
        networks: ["default"],
      },
    },
  };
}
function record(run?: string) {
  return {
    version: 2 as const,
    kind: "native-authored-project-run" as const,
    receipt: parseNativeAuthoredReceipt(receipt(run)),
  };
}
function cleaned(bound = receipt()) {
  return parseNativeAuthoredReceipt({
    ...bound,
    phase: "removed",
    resources: Object.fromEntries(
      Object.entries(bound.resources).map(([key, resource]) => [
        key,
        { ...resource, phase: "removed" },
      ])
    ),
  });
}
async function fixture() {
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-authored-artifact-"))
  );
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack");
  const nativeHome = join(projectRoot, "candidate");
  await mkdir(projectDir, { mode: 0o755 });
  await mkdir(nativeHome, { mode: 0o700 });
  return { projectRoot, projectDir, nativeHome, branch: null };
}
async function file(opts: Awaited<ReturnType<typeof fixture>>) {
  const root = join(opts.projectDir, ".internal", "native-authored-runs");
  const name = (await readdir(root)).find((entry) => entry.endsWith(".json"));
  if (!name) {
    throw new Error("test requires published artifact");
  }
  return join(root, name);
}

test("absent native artifact reads have no writes and storage remains private and excluded", async () => {
  const opts = await fixture();
  expect(await load(opts)).toBeNull();
  expect(await readdir(opts.projectDir)).toEqual([]);
  await prepare(opts);
  const root = join(opts.projectDir, ".internal", "native-authored-runs");
  expect((await stat(root)).mode & 0o777).toBe(0o700);
  expect(await Bun.file(join(root, ".gitignore")).text()).toBe("*\n");
  const saved = await save({ ...opts, record: record() });
  expect(await load(opts)).toEqual(saved);
  expect((await stat(await file(opts))).mode & 0o777).toBe(0o600);
  expect((await stat(await file(opts))).nlink).toBe(1);
  expect(saved.record.kind).toBe("native-authored-project-run");
  expect(JSON.stringify(saved)).not.toContain("planId");
});

test("native artifact and unchanged strict Compose v1 mapping are separate formats and paths", async () => {
  const opts = await fixture();
  const legacy = {
    run: "4".repeat(32),
    owner: "5".repeat(32),
    namespace: "6".repeat(64),
    planId: "7".repeat(64),
  };
  await saveCompose({ ...opts, run: legacy });
  const oldRoot = join(opts.projectDir, ".internal", "native-runs");
  const oldName = (await readdir(oldRoot)).find((entry) =>
    entry.endsWith(".json")
  );
  if (!oldName) {
    throw new Error("test requires legacy artifact");
  }
  const oldFile = join(oldRoot, oldName);
  const oldBytes = await Bun.file(oldFile).text();
  const selected = await save({ ...opts, record: record() });
  const nativeFile = await file(opts);
  expect(await loadCompose(opts)).toEqual(legacy);
  expect(await Bun.file(oldFile).text()).toBe(oldBytes);
  expect((JSON.parse(oldBytes) as { version: unknown }).version).toBe(1);
  await remove({ ...opts, expected: selected, cleaned: cleaned() });
  expect(await load(opts)).toBeNull();
  expect(await loadCompose(opts)).toEqual(legacy);
  await Bun.write(nativeFile, oldBytes);
  await chmod(nativeFile, 0o600);
  await expect(load(opts)).rejects.toThrow("unsafe");
  await Bun.write(
    oldFile,
    JSON.stringify({ ...JSON.parse(oldBytes), run: selected.record })
  );
  await expect(loadCompose(opts)).rejects.toThrow("unsafe");
});

test("exclusive publication has one winner and refuses replacement or abandoned mutation locks", async () => {
  const opts = await fixture();
  await prepare(opts);
  const results = await Promise.allSettled([
    save({ ...opts, record: record() }),
    save({ ...opts, record: record("9".repeat(32)) }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled")
  ).toHaveLength(1);
  const original = await load(opts);
  expect(original).not.toBeNull();
  await expect(save({ ...opts, record: record() })).rejects.toThrow("unsafe");
  expect(await load(opts)).toEqual(original);
  expect(
    (
      await readdir(join(opts.projectDir, ".internal", "native-authored-runs"))
    ).filter((entry) => entry.endsWith(".pending"))
  ).toEqual([]);
  const artifact = await file(opts);
  const lock = artifact.replace(/\.json$/, ".lock");
  await mkdir(lock, { mode: 0o700 });
  if (!original) {
    throw new Error("test requires selected artifact");
  }
  await expect(
    remove({
      ...opts,
      expected: original,
      cleaned: cleaned(receipt(original.record.receipt.review.provenance.run)),
    })
  ).rejects.toThrow("unsafe");
  expect(await readdir(lock)).toEqual([]);
  expect(await load(opts)).toEqual(original);
});

test("removed evidence must bind exact original owner boot readiness images and immutable resource IDs", async () => {
  const opts = await fixture();
  const original = await save({ ...opts, record: record() });
  await expect(
    remove({ ...opts, expected: original, cleaned: original.record.receipt })
  ).rejects.toThrow("unsafe");
  for (const mutate of [
    (value: ReturnType<typeof receipt>) => {
      value.owner = "9".repeat(32);
    },
    (value: ReturnType<typeof receipt>) => {
      value.boot = "00000000-0000-0000-0000-000000000002";
    },
    (value: ReturnType<typeof receipt>) => {
      value.resources["container:web"].id = "9".repeat(64);
    },
    (value: ReturnType<typeof receipt>) => {
      value.resources["container:web"].image = `sha256:${"9".repeat(64)}`;
    },
    (value: ReturnType<typeof receipt>) => {
      value.readiness.web = "started";
    },
  ]) {
    const changed = receipt();
    mutate(changed);
    await expect(
      remove({ ...opts, expected: original, cleaned: cleaned(changed) })
    ).rejects.toThrow("unsafe");
    expect(await load(opts)).toEqual(original);
  }
  await remove({ ...opts, expected: original, cleaned: cleaned() });
  expect(await load(opts)).toBeNull();
});

test("same JSON at a replacement inode cannot be retired using the previous selection", async () => {
  const opts = await fixture();
  const original = await save({ ...opts, record: record() });
  const target = await file(opts);
  const replacement = `${target}.replacement`;
  await Bun.write(replacement, await Bun.file(target).text());
  await chmod(replacement, 0o600);
  await rename(replacement, target);
  const current = await load(opts);
  expect(current?.record).toEqual(original.record);
  expect(current?.identity.ino).not.toBe(original.identity.ino);
  await expect(
    remove({ ...opts, expected: original, cleaned: cleaned() })
  ).rejects.toThrow("unsafe");
  expect(await load(opts)).toEqual(current);
});

test("changed candidate or project directory identity refuses before artifact retirement", async () => {
  for (const selected of ["nativeHome", "projectDir"] as const) {
    const opts = await fixture();
    const original = await save({ ...opts, record: record() });
    await rename(opts[selected], `${opts[selected]}-old`);
    await mkdir(opts[selected], { mode: 0o700 });
    if (selected === "projectDir") {
      await cp(
        join(`${opts.projectDir}-old`, ".internal"),
        join(opts.projectDir, ".internal"),
        { recursive: true }
      );
    }
    await expect(load(opts)).rejects.toThrow("unsafe");
    await expect(
      remove({ ...opts, expected: original, cleaned: cleaned() })
    ).rejects.toThrow("unsafe");
  }
});

test("symbolic storage redirects hardlinked files and public permissions refuse", async () => {
  const redirected = await fixture();
  await symlink(
    redirected.nativeHome,
    join(redirected.projectDir, ".internal")
  );
  await expect(prepare(redirected)).rejects.toThrow("unsafe");
  for (const mutate of [
    async (target: string) => {
      await chmod(target, 0o644);
    },
    async (target: string) => {
      await link(target, `${target}.alias`);
    },
    async (target: string) => {
      await rename(target, `${target}.old`);
      await symlink(`${target}.old`, target);
    },
  ]) {
    const opts = await fixture();
    const original = await save({ ...opts, record: record() });
    await mutate(await file(opts));
    await expect(load(opts)).rejects.toThrow("unsafe");
    await expect(
      remove({ ...opts, expected: original, cleaned: cleaned() })
    ).rejects.toThrow("unsafe");
  }
});

test("native tagged selection refuses legacy and failed records before storage", async () => {
  const opts = await fixture();
  for (const wire of [
    { ...record(), version: 1 },
    { ...record(), kind: "normalized-compose" },
    { ...record(), planId: "9".repeat(64) },
    { ...record(), receipt: { ...receipt(), phase: "preparing" } },
  ]) {
    await expect(save({ ...opts, record: wire })).rejects.toThrow();
  }
  expect(await readdir(opts.projectDir)).toEqual([]);
});

test("shared internal metadata permissions stay unchanged and branch scopes remain exact", async () => {
  const opts = await fixture();
  const internal = join(opts.projectDir, ".internal");
  await mkdir(internal, { mode: 0o755 });
  await prepare(opts);
  expect((await stat(internal)).mode & 0o777).toBe(0o755);
  const original = await save({ ...opts, record: record() });
  const branch = "feature/\u{1F408}";
  const other = await save({ ...opts, branch, record: record("9".repeat(32)) });
  expect(await load({ ...opts, branch })).toEqual(other);
  await remove({ ...opts, expected: original, cleaned: cleaned() });
  expect(await load({ ...opts, branch })).toEqual(other);
  for (const invalid of ["", "bad\nbranch", "\uD800", "w".repeat(257)]) {
    await expect(load({ ...opts, branch: invalid })).rejects.toThrow("unsafe");
  }
});
