import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
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
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNativeAuthoredReceipt } from "../src/backends/native-authored-graph-protocol.ts";
import {
  withNativeAuthoredProjectAdmission as admit,
  loadNativeAuthoredProjectRun as load,
  prepareNativeAuthoredProjectRunStorage as prepare,
  removeNativeAuthoredProjectRun as remove,
  saveNativeAuthoredProjectRun as save,
} from "../src/backends/native-authored-project-run.ts";
import {
  loadNativeProjectRun as loadCompose,
  saveNativeProjectRun as saveCompose,
} from "../src/backends/native-project-run.ts";
import { isRecord } from "../src/lib/guards.ts";
import type { NativeEnvMetadata } from "../src/lib/native-env-plan-protocol.ts";

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
function metadata(): NativeEnvMetadata {
  return {
    metadata_version: 1,
    overlay: null,
    overlay_exists: true,
    workloads: { web: { TOKEN: { scope: "global", secret: true } } },
    inactive_scopes: ["off"],
  };
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

test.each([
  "replace",
  "mutate",
])("caller %s cannot substitute a newer selection during stale retirement", async (change) => {
  const scope = await fixture();
  const old = await save({ ...scope, record: record() });
  await remove({ ...scope, expected: old, cleaned: cleaned() });
  const current = await save({ ...scope, record: record("9".repeat(32)) });
  const opts = {
    ...scope,
    expected: { record: old.record, identity: { ...old.identity } },
    cleaned: cleaned(),
  };
  const pending = remove(opts);
  if (change === "replace") {
    opts.expected = {
      record: current.record,
      identity: { ...current.identity },
    };
  } else {
    opts.expected.record = current.record;
    Object.assign(opts.expected.identity, current.identity);
  }
  await expect(pending).rejects.toThrow("unsafe");
  expect(await load(scope)).toEqual(current);
});

test("caller scope replacement cannot redirect publication after admission begins", async () => {
  const scope = await fixture();
  const other = await fixture();
  const opts = { ...scope, record: record() };
  const pending = save(opts);
  Object.assign(opts, other);
  const published = await pending;
  expect(await load(scope)).toEqual(published);
  expect(await load(other)).toBeNull();
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

test("startup admission excludes a concurrent caller and invalidates an escaped capability", async () => {
  const opts = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let escaped: Parameters<Parameters<typeof admit>[1]>[0] | undefined;
  const first = admit(opts, async (admission) => {
    escaped = admission;
    entered.resolve();
    await release.promise;
    await admission.assertHeld();
  });
  await entered.promise;
  await expect(admit(opts, () => Promise.resolve())).rejects.toThrow("unsafe");
  release.resolve();
  await first;
  if (!escaped) {
    throw new Error("test requires captured admission");
  }
  await expect(escaped.assertHeld()).rejects.toThrow("unsafe");
  await expect(
    escaped.reserve({ review: record().receipt.review })
  ).rejects.toThrow("unsafe");
  await admit(opts, (admission) => admission.assertHeld());
});

test("failed pre-publication startup retains a private hash-only intent and blocks a fresh start", async () => {
  const opts = await fixture();
  let intent:
    | Awaited<ReturnType<Parameters<Parameters<typeof admit>[1]>[0]["reserve"]>>
    | undefined;
  await expect(
    admit(opts, async (admission) => {
      intent = await admission.reserve({ review: record().receipt.review });
      throw new Error("synthetic preparation failure");
    })
  ).rejects.toThrow("unsafe");
  expect(await load(opts)).toBeNull();
  if (!intent) {
    throw new Error("test requires reserved intent");
  }
  const expected = intent;
  const root = join(opts.projectDir, ".internal", "native-authored-runs");
  const startName = (await readdir(root)).find((name) =>
    name.endsWith(".start.json")
  );
  if (!startName) {
    throw new Error("test requires durable intent");
  }
  const start = join(root, startName);
  expect((await stat(start)).mode & 0o777).toBe(0o600);
  expect((await stat(start)).nlink).toBe(1);
  expect(JSON.parse(await Bun.file(start).text()).record).toEqual(
    expected.record
  );
  expect(JSON.stringify(expected)).not.toMatch(/values|planId|owner|boot/);
  await admit(opts, async (admission) => {
    expect(await admission.loadStart()).toEqual(expected);
    await expect(
      admission.reserve({ review: record("9".repeat(32)).receipt.review })
    ).rejects.toThrow("unsafe");
    await expect(save({ ...opts, record: record() })).rejects.toThrow("unsafe");
    expect(await admission.loadStart()).toEqual(expected);
  });
});

test("ready publication and retirement require the exact unchanged reserved review", async () => {
  const opts = await fixture();
  await admit(opts, async (admission) => {
    const expectedStart = await admission.reserve({
      review: record().receipt.review,
    });
    await expect(
      admission.publish({ expectedStart, record: record("9".repeat(32)) })
    ).rejects.toThrow("unsafe");
    expect(await load(opts)).toBeNull();
    expect(await admission.loadStart()).toEqual(expectedStart);
    const expectedRun = await admission.publish({
      expectedStart,
      record: record(),
    });
    expect(await load(opts)).toEqual(expectedRun);
    await expect(
      remove({ ...opts, expected: expectedRun, cleaned: cleaned() })
    ).rejects.toThrow("unsafe");
    await expect(
      admission.retire({ expectedStart, cleaned: cleaned() })
    ).rejects.toThrow("unsafe");
    await expect(
      admission.retire({
        expectedStart,
        expectedRun,
        cleaned: cleaned(receipt("9".repeat(32))),
      })
    ).rejects.toThrow("unsafe");
    const changed = receipt();
    changed.resources["container:web"].id = "9".repeat(64);
    await expect(
      admission.retire({
        expectedStart,
        expectedRun,
        cleaned: cleaned(changed),
      })
    ).rejects.toThrow("unsafe");
    expect(await load(opts)).toEqual(expectedRun);
    expect(await admission.loadStart()).toEqual(expectedStart);
    await admission.retire({ expectedStart, expectedRun, cleaned: cleaned() });
    expect(await load(opts)).toBeNull();
    expect(await admission.loadStart()).toBeNull();
    await admission.reserve({ review: record("9".repeat(32)).receipt.review });
  });
});

test("interrupted retirement with ready artifact removed retains the blocking startup intent", async () => {
  const opts = await fixture();
  await admit(opts, async (admission) => {
    const expectedStart = await admission.reserve({
      review: record().receipt.review,
    });
    const expectedRun = await admission.publish({
      expectedStart,
      record: record(),
    });
    const root = join(opts.projectDir, ".internal", "native-authored-runs");
    const ready = (await readdir(root)).find(
      (name) => name.endsWith(".json") && !name.endsWith(".start.json")
    );
    if (!ready) {
      throw new Error("test requires ready artifact");
    }
    // Reproduce the durable boundary after ready unlink, before intent unlink.
    await unlink(join(root, ready));
    expect(await load(opts)).toBeNull();
    expect(await admission.loadStart()).toEqual(expectedStart);
    await expect(
      admission.reserve({ review: record("9".repeat(32)).receipt.review })
    ).rejects.toThrow("unsafe");
    await expect(
      admission.retire({ expectedStart, expectedRun, cleaned: cleaned() })
    ).rejects.toThrow("unsafe");
    expect(await admission.loadStart()).toEqual(expectedStart);
    await admission.retire({ expectedStart, cleaned: cleaned() });
    expect(await admission.loadStart()).toBeNull();
  });
});

test("a replaced startup file or admission authority cannot publish or retire", async () => {
  for (const replace of ["start", "owner"] as const) {
    const opts = await fixture();
    await expect(
      admit(opts, async (admission) => {
        const expectedStart = await admission.reserve({
          review: record().receipt.review,
        });
        const root = join(opts.projectDir, ".internal", "native-authored-runs");
        const name = (await readdir(root)).find((entry) =>
          entry.endsWith(
            replace === "start" ? ".start.json" : ".admission.lock"
          )
        );
        if (!name) {
          throw new Error("test requires admitted authority");
        }
        const target =
          replace === "start" ? join(root, name) : join(root, name, "owner");
        await Bun.write(`${target}.replacement`, await Bun.file(target).text());
        await chmod(`${target}.replacement`, 0o600);
        await rename(`${target}.replacement`, target);
        await expect(
          admission.publish({ expectedStart, record: record() })
        ).rejects.toThrow("unsafe");
        await expect(
          admission.retire({ expectedStart, cleaned: cleaned() })
        ).rejects.toThrow("unsafe");
        expect(await load(opts)).toBeNull();
        if (replace === "start") {
          expect((await admission.loadStart())?.identity.ino).not.toBe(
            expectedStart.identity.ino
          );
          throw new Error("retain replaced intent");
        }
      })
    ).rejects.toThrow("unsafe");
  }
});

test("stale startup caller mutation cannot publish or retire a newer run", async () => {
  const opts = await fixture();
  await admit(opts, async (admission) => {
    const old = await admission.reserve({ review: record().receipt.review });
    await admission.retire({ expectedStart: old, cleaned: cleaned() });
    const current = await admission.reserve({
      review: record("9".repeat(32)).receipt.review,
    });
    const publication = {
      expectedStart: { record: old.record, identity: { ...old.identity } },
      record: record("9".repeat(32)),
    };
    const pendingPublication = admission.publish(publication);
    publication.expectedStart = current;
    await expect(pendingPublication).rejects.toThrow("unsafe");
    const retirement = {
      expectedStart: { record: old.record, identity: { ...old.identity } },
      cleaned: cleaned(),
    };
    const pendingRetirement = admission.retire(retirement);
    retirement.expectedStart.record = current.record;
    Object.assign(retirement.expectedStart.identity, current.identity);
    await expect(pendingRetirement).rejects.toThrow("unsafe");
    expect(await admission.loadStart()).toEqual(current);
    expect(await load(opts)).toBeNull();
  });
});

test("retained ready runs and abandoned admission locks refuse new startup", async () => {
  const opts = await fixture();
  const existing = await save({ ...opts, record: record() });
  await admit(opts, async (admission) => {
    await expect(
      admission.reserve({ review: record("9".repeat(32)).receipt.review })
    ).rejects.toThrow("unsafe");
    expect(await admission.loadStart()).toBeNull();
    expect(await load(opts)).toEqual(existing);
  });
  const target = await file(opts);
  const lock = target.replace(/\.json$/, ".admission.lock");
  await mkdir(lock, { mode: 0o700 });
  await expect(admit(opts, () => Promise.resolve())).rejects.toThrow("unsafe");
  expect(await readdir(lock)).toEqual([]);
  expect(await load(opts)).toEqual(existing);
});

test("SIGKILL after startup intent leaves evidence and refuses implicit dead-owner recovery", async () => {
  const opts = await fixture();
  const module = new URL(
    "../src/backends/native-authored-project-run.ts",
    import.meta.url
  ).pathname;
  const script = `import { withNativeAuthoredProjectAdmission } from ${JSON.stringify(module)};
await withNativeAuthoredProjectAdmission(${JSON.stringify(opts)}, async (admission) => {
  await admission.reserve({review:${JSON.stringify(record().receipt.review)}});
  console.log('intent-published');
  await Bun.sleep(60_000);
});`;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
  try {
    const reader = child.stdout.getReader();
    try {
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toBe("intent-published\n");
    } finally {
      reader.releaseLock();
    }
    child.kill("SIGKILL");
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    expect(await load(opts)).toBeNull();
    const root = join(opts.projectDir, ".internal", "native-authored-runs");
    const names = await readdir(root);
    expect(names.filter((name) => name.endsWith(".start.json"))).toHaveLength(
      1
    );
    expect(
      names.filter((name) => name.endsWith(".admission.lock"))
    ).toHaveLength(1);
    await expect(admit(opts, () => Promise.resolve())).rejects.toThrow(
      "unsafe"
    );
    expect(await readdir(root)).toEqual(names);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
});

test("startup intent decoding is closed and malformed private content stays out of refusals", async () => {
  const opts = await fixture();
  await admit(opts, async (admission) => {
    const start = await admission.reserve({ review: record().receipt.review });
    const root = join(opts.projectDir, ".internal", "native-authored-runs");
    const name = (await readdir(root)).find((entry) =>
      entry.endsWith(".start.json")
    );
    if (!name) {
      throw new Error("test requires intent");
    }
    const target = join(root, name);
    const initial: unknown = JSON.parse(await Bun.file(target).text());
    if (!isRecord(initial)) {
      throw new Error("test requires startup record");
    }
    const canary = "private-synthetic-startup-artifact-canary";
    for (const invalid of [
      JSON.stringify({
        ...initial,
        record: { ...start.record, values: canary },
      }),
      `{"values":"${canary}",`,
    ]) {
      await Bun.write(target, invalid);
      const error: unknown = await admission
        .loadStart()
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("unsafe");
      expect(String(error)).not.toContain(canary);
      expect(JSON.stringify(error)).not.toContain(canary);
      await expect(
        admission.reserve({ review: record("9".repeat(32)).receipt.review })
      ).rejects.toThrow("unsafe");
    }
  });
});

test("held admission publishes only the captured public native source envelope", async () => {
  const opts = { ...(await fixture()), branch: "work" };
  await admit(opts, async (admission) => {
    const input = {
      run: "a".repeat(32),
      metadata: {
        ...metadata(),
        workloads: { web: { TOKEN: { scope: "global", secret: true } } },
      },
      profiles: ["debug"],
      overlay: null as string | null,
    };
    const pending = admission.prepareSource(input);
    input.run = "9".repeat(32);
    input.profiles[0] = "later";
    input.overlay = "later";
    input.metadata.workloads.web.TOKEN.scope = "later";
    const source = await pending;
    expect(Object.isFrozen(source)).toBe(true);
    expect(JSON.parse(await Bun.file(source.path).text())).toEqual({
      version: 2,
      kind: "native-graph-source",
      project: opts.projectRoot,
      branch: "work",
      run: "a".repeat(32),
      profiles: ["debug"],
      overlay: "base",
      env_metadata: metadata(),
    });
    expect((await stat(source.path)).mode & 0o777).toBe(0o600);
    expect((await stat(source.path)).nlink).toBe(1);
    expect(source.path).toStartWith(
      join(opts.projectDir, ".internal", "native-authored-runs")
    );
    await source.assertFresh();
    await source.remove();
    expect(await Bun.file(source.path).exists()).toBe(false);
    expect(await admission.loadStart()).toBeNull();
    expect(await load(opts)).toBeNull();
  });
});

test("native source metadata refuses private extras and oversized transport before writing", async () => {
  const opts = await fixture();
  const canary = "private-synthetic-source-owner-canary";
  await admit(opts, async (admission) => {
    const input = {
      run: "a".repeat(32),
      metadata: {
        ...metadata(),
        workloads: {
          web: { TOKEN: { scope: "global", secret: true, value: canary } },
        },
      },
    };
    const error: unknown = await admission
      .prepareSource(input)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(canary);
    expect(JSON.stringify(error)).not.toContain(canary);
    await expect(
      admission.prepareSource({
        run: "a".repeat(32),
        metadata: {
          ...metadata(),
          inactive_scopes: ["a".repeat(1024 * 1024)],
        },
      })
    ).rejects.toThrow("unsafe");
    const root = join(opts.projectDir, ".internal", "native-authored-runs");
    expect(
      (await readdir(root)).filter((name) => name.endsWith(".json"))
    ).toEqual([]);
  });
});

test("native source ownership refuses replaced bytes inode permissions or hardlinks", async () => {
  for (const attack of ["bytes", "inode", "mode", "links"] as const) {
    const opts = await fixture();
    await admit(opts, async (admission) => {
      const source = await admission.prepareSource({
        run: "a".repeat(32),
        metadata: metadata(),
      });
      if (attack === "bytes") {
        await Bun.write(source.path, "{}\n");
      } else if (attack === "inode") {
        await Bun.write(
          `${source.path}.replacement`,
          await Bun.file(source.path).text()
        );
        await chmod(`${source.path}.replacement`, 0o600);
        await rename(`${source.path}.replacement`, source.path);
      } else if (attack === "mode") {
        await chmod(source.path, 0o644);
      } else {
        await link(source.path, `${source.path}.alias`);
      }
      await expect(source.assertFresh()).rejects.toThrow("unsafe");
      await expect(source.remove()).rejects.toThrow("unsafe");
      expect(await Bun.file(source.path).exists()).toBe(true);
    });
  }
});

test("source remains with retained startup or ready evidence and retires after exact Removed", async () => {
  const opts = await fixture();
  await admit(opts, async (admission) => {
    const source = await admission.prepareSource({
      run: "a".repeat(32),
      metadata: metadata(),
    });
    const expectedStart = await admission.reserve({
      review: record().receipt.review,
    });
    await expect(source.remove()).rejects.toThrow("unsafe");
    await expect(
      admission.prepareSource({ run: "9".repeat(32), metadata: metadata() })
    ).rejects.toThrow("unsafe");
    let guarded = 0;
    const expectedRun = await admission.publish({
      expectedStart,
      record: record(),
      assertReady: () => {
        guarded += 1;
        return undefined;
      },
    });
    expect(guarded).toBe(1);
    await expect(source.remove()).rejects.toThrow("unsafe");
    await source.assertFresh();
    await admission.retire({ expectedStart, expectedRun, cleaned: cleaned() });
    await source.remove();
    expect(await Bun.file(source.path).exists()).toBe(false);
  });
});

test("source capabilities cannot escape the admission lifetime or replace a same-run source", async () => {
  const opts = await fixture();
  let source:
    | Awaited<
        ReturnType<Parameters<Parameters<typeof admit>[1]>[0]["prepareSource"]>
      >
    | undefined;
  await admit(opts, async (admission) => {
    source = await admission.prepareSource({
      run: "a".repeat(32),
      metadata: metadata(),
      overlay: "staging",
    });
    expect(JSON.parse(await Bun.file(source.path).text()).overlay).toEqual({
      named: "staging",
    });
    await expect(
      admission.prepareSource({ run: "a".repeat(32), metadata: metadata() })
    ).rejects.toThrow("unsafe");
    await source.assertFresh();
  });
  if (!source) {
    throw new Error("test requires source capability");
  }
  await expect(source.assertFresh()).rejects.toThrow("unsafe");
  await expect(source.remove()).rejects.toThrow("unsafe");
  expect(await Bun.file(source.path).exists()).toBe(true);
});

test("ready publication checks the captured synchronous owner guard after pending output exists", async () => {
  const opts = await fixture();
  await admit(opts, async (admission) => {
    const expectedStart = await admission.reserve({
      review: record().receipt.review,
    });
    const root = join(opts.projectDir, ".internal", "native-authored-runs");
    let guarded = 0;
    const input = {
      expectedStart,
      record: record(),
      assertReady: (): undefined => {
        guarded += 1;
        expect(
          readdirSync(root).filter((name) => name.endsWith(".pending"))
        ).toHaveLength(1);
        throw new Error("synthetic canceled owner");
      },
    };
    const pending = admission.publish(input);
    input.assertReady = () => {
      guarded += 100;
      return undefined;
    };
    await expect(pending).rejects.toThrow("unsafe");
    expect(guarded).toBe(1);
    expect(await load(opts)).toBeNull();
    expect(await admission.loadStart()).toEqual(expectedStart);
    expect(
      readdirSync(root).filter((name) => name.endsWith(".pending"))
    ).toEqual([]);
  });
});

test("an asynchronous rejecting ready guard never publishes or leaks a private diagnostic", async () => {
  const opts = await fixture();
  const canary = "private-synthetic-async-ready-guard-canary";
  const completed = Promise.withResolvers<void>();
  await admit(opts, async (admission) => {
    const expectedStart = await admission.reserve({
      review: record().receipt.review,
    });
    const asynchronous = async () => {
      await Bun.sleep(10);
      completed.resolve();
      throw new Error(canary);
    };
    // Simulate an untyped caller. The public type deliberately excludes Promise returns.
    const assertReady = asynchronous as unknown as () => undefined;
    const error: unknown = await admission
      .publish({ expectedStart, record: record(), assertReady })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("unsafe");
    expect(String(error)).not.toContain(canary);
    expect(JSON.stringify(error)).not.toContain(canary);
    await completed.promise;
    await Bun.sleep(0);
    expect(await load(opts)).toBeNull();
    expect(await admission.loadStart()).toEqual(expectedStart);
    const root = join(opts.projectDir, ".internal", "native-authored-runs");
    expect(
      readdirSync(root).filter((name) => name.endsWith(".pending"))
    ).toEqual([]);
  });
});
