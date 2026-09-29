import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginNativeProjectFinalization,
  captureNativeProjectFinalization,
  isNativeProjectFinalizationToken,
  recoverNativeProjectFinalization,
  waitNativeProjectFinalization,
} from "../src/backends/native-project-finalization.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-finalization-"))
  );
  roots.push(root);
  await mkdir(join(root, ".hack"));
  return {
    scope: {
      nativeHome: root,
      projectRoot: root,
      projectDir: join(root, ".hack"),
      branch: null,
    },
    run: {
      run: "a".repeat(32),
      owner: "b".repeat(32),
      namespace: "c".repeat(64),
      planId: "d".repeat(64),
    },
  };
}
function httpsLease(run: Awaited<ReturnType<typeof fixture>>["run"]) {
  return {
    version: 1 as const,
    ownerGeneration: "1".repeat(32),
    leaseId: "2".repeat(32),
    run: run.run,
    attempt: "3".repeat(32),
    owner: run.owner,
    namespace: run.namespace,
    planId: run.planId,
  };
}
test("shared HTTPS finalization v3 binds the exact lease and never inherits a stale completion", async () => {
  const opts = await fixture();
  const lease = httpsLease(opts.run);
  for (const invalid of [
    { ...lease, ownerGeneration: "not-a-generation" },
    { ...lease, leaseId: "not-a-lease" },
    { ...lease, owner: "f".repeat(32) },
    { ...lease, run: "f".repeat(32) },
    { ...lease, namespace: "f".repeat(64) },
    { ...lease, planId: "f".repeat(64) },
  ]) {
    await expect(
      beginNativeProjectFinalization({
        ...opts,
        httpsPort: 18_443,
        httpsLease: invalid,
      })
    ).rejects.toThrow("unconfirmed");
  }
  await expect(
    beginNativeProjectFinalization({
      ...opts,
      httpsPort: null,
      httpsLease: lease,
    })
  ).rejects.toThrow("unconfirmed");
  expect(await readdir(opts.scope.nativeHome)).toEqual([".hack"]);
  const first = await beginNativeProjectFinalization({
    ...opts,
    httpsPort: 18_443,
    httpsLease: lease,
  });
  expect(first.token).toMatchObject({
    version: 3,
    attempt: lease.attempt,
    pid: process.pid,
    httpsPort: 18_443,
    httpsLease: lease,
  });
  expect(isNativeProjectFinalizationToken(first.token)).toBe(true);
  expect(await captureNativeProjectFinalization(opts)).toEqual(first.token);
  await first.complete();
  const secondLease = {
    ...lease,
    ownerGeneration: "4".repeat(32),
    leaseId: "5".repeat(32),
  };
  const second = await beginNativeProjectFinalization({
    ...opts,
    httpsPort: 18_443,
    httpsLease: secondLease,
  });
  expect(second.token.attempt).toBe(first.token.attempt);
  await expect(
    waitNativeProjectFinalization({
      ...opts,
      token: second.token,
      timeoutMs: 1,
    })
  ).rejects.toThrow("unconfirmed");
  await expect(first.complete()).rejects.toThrow("unconfirmed");
  if (second.token.version !== 3) {
    throw new Error("expected v3 finalizer");
  }
  const forged = {
    ...second.token,
    httpsLease: { ...second.token.httpsLease, leaseId: "6".repeat(32) },
  };
  expect(isNativeProjectFinalizationToken(forged)).toBe(true);
  await expect(
    waitNativeProjectFinalization({ ...opts, token: forged, timeoutMs: 1 })
  ).rejects.toThrow("unconfirmed");
  await second.complete();
  await waitNativeProjectFinalization({
    ...opts,
    token: second.token,
    timeoutMs: 1,
  });
});
test("dead v3 frontend recovery requires its exact persisted HTTPS lease", async () => {
  const opts = await fixture();
  const lifetime = await beginNativeProjectFinalization({
    ...opts,
    httpsPort: 18_443,
    httpsLease: httpsLease(opts.run),
  });
  if (lifetime.token.version !== 3) {
    throw new Error("expected v3 finalizer");
  }
  let observations = 0;
  const recovery = {
    ...opts,
    token: lifetime.token,
    expectAttempt: lifetime.token.attempt,
    isDead: () => true,
    verifyEffects: async () => {
      observations++;
    },
  };
  await expect(
    recoverNativeProjectFinalization({
      ...recovery,
      token: {
        ...lifetime.token,
        httpsLease: {
          ...lifetime.token.httpsLease,
          ownerGeneration: "f".repeat(32),
        },
      },
    })
  ).rejects.toThrow("unconfirmed");
  expect(observations).toBe(0);
  await expect(
    recoverNativeProjectFinalization({
      ...recovery,
      verifyEffects: async () => {
        throw new Error("lease recovery uncertain");
      },
    })
  ).rejects.toThrow("lease recovery uncertain");
  await expect(
    waitNativeProjectFinalization({
      ...opts,
      token: lifetime.token,
      timeoutMs: 1,
    })
  ).rejects.toThrow("unconfirmed");
  await recoverNativeProjectFinalization(recovery);
  expect(observations).toBe(1);
  await waitNativeProjectFinalization({
    ...opts,
    token: lifetime.token,
    timeoutMs: 1,
  });
});
test("capture binds exact attempt and waits for explicit finalizer completion", async () => {
  const opts = await fixture();
  const lifetime = await beginNativeProjectFinalization(opts);
  const token = await captureNativeProjectFinalization(opts);
  expect(token).toEqual(lifetime.token);
  await expect(
    waitNativeProjectFinalization({ ...opts, token, timeoutMs: 1 })
  ).rejects.toThrow("unconfirmed");
  await lifetime.complete();
  await waitNativeProjectFinalization({ ...opts, token, timeoutMs: 1 });
});
test("same-run restore cannot reuse stale acknowledgement or supersede incomplete owner", async () => {
  const opts = await fixture();
  const old = await beginNativeProjectFinalization(opts);
  await expect(beginNativeProjectFinalization(opts)).rejects.toThrow(
    "unconfirmed"
  );
  await old.complete();
  const next = await beginNativeProjectFinalization(opts);
  expect(next.token.attempt).not.toBe(old.token.attempt);
  await expect(
    waitNativeProjectFinalization({ ...opts, token: next.token, timeoutMs: 1 })
  ).rejects.toThrow("unconfirmed");
  await expect(old.complete()).rejects.toThrow("unconfirmed");
  await next.complete();
  await waitNativeProjectFinalization({
    ...opts,
    token: next.token,
    timeoutMs: 1,
  });
});
test("tokens cannot cross run, branch, or plan identities", async () => {
  const opts = await fixture();
  const lifetime = await beginNativeProjectFinalization(opts);
  await lifetime.complete();
  await expect(
    waitNativeProjectFinalization({
      ...opts,
      run: { ...opts.run, planId: "e".repeat(64) },
      token: lifetime.token,
      timeoutMs: 1,
    })
  ).rejects.toThrow();
  await expect(
    waitNativeProjectFinalization({
      ...opts,
      scope: { ...opts.scope, branch: "other" },
      token: lifetime.token,
      timeoutMs: 1,
    })
  ).rejects.toThrow();
  await expect(
    waitNativeProjectFinalization({
      ...opts,
      token: { ...lifetime.token, attempt: "f".repeat(32) },
      timeoutMs: 1,
    })
  ).rejects.toThrow();
});
test("symlinked completion is refused and registration is exclusive", async () => {
  const opts = await fixture();
  const result = await Promise.allSettled([
    beginNativeProjectFinalization(opts),
    beginNativeProjectFinalization(opts),
  ]);
  expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  const lifetime = result.find((item) => item.status === "fulfilled");
  if (lifetime?.status !== "fulfilled") {
    throw new Error("missing owner");
  }
  const base = join(opts.scope.nativeHome, ".hack-local/frontend-finalization");
  const [hash] = await readdir(base);
  if (!hash) {
    throw new Error("missing scope");
  }
  await symlink("/dev/zero", join(base, hash, opts.run.run, "completed.json"));
  await expect(
    waitNativeProjectFinalization({
      ...opts,
      token: lifetime.value.token,
      timeoutMs: 1,
    })
  ).rejects.toThrow();
});

test("dead frontend recovery is explicit, exact, and distinct from completion", async () => {
  const opts = await fixture();
  const prior = await beginNativeProjectFinalization(opts);
  await prior.complete();
  const lifetime = await beginNativeProjectFinalization({
    ...opts,
    httpsPort: 18_443,
  });
  expect(lifetime.token).toMatchObject({
    version: 2,
    pid: process.pid,
    httpsPort: 18_443,
  });
  let observations = 0;
  const recovery = {
    ...opts,
    token: lifetime.token,
    expectAttempt: lifetime.token.attempt,
    verifyEffects: async () => {
      observations++;
    },
  };
  await expect(
    recoverNativeProjectFinalization({
      ...recovery,
      expectAttempt: "f".repeat(32),
      isDead: () => true,
    })
  ).rejects.toThrow("unconfirmed");
  await expect(
    recoverNativeProjectFinalization({
      ...recovery,
      isDead: () => false,
    })
  ).rejects.toThrow("unconfirmed");
  expect(observations).toBe(0);
  await expect(
    recoverNativeProjectFinalization({
      ...recovery,
      isDead: () => true,
      verifyEffects: async () => {
        throw new Error("live HTTPS owner");
      },
    })
  ).rejects.toThrow("live HTTPS owner");
  await expect(
    waitNativeProjectFinalization({
      ...opts,
      token: lifetime.token,
      timeoutMs: 1,
    })
  ).rejects.toThrow("unconfirmed");
  await recoverNativeProjectFinalization({
    ...recovery,
    isDead: () => true,
  });
  expect(observations).toBe(1);
  await waitNativeProjectFinalization({
    ...opts,
    token: lifetime.token,
    timeoutMs: 1,
  });
  const next = await beginNativeProjectFinalization(opts);
  expect(next.token.attempt).not.toBe(lifetime.token.attempt);
  await expect(
    waitNativeProjectFinalization({
      ...opts,
      token: lifetime.token,
      timeoutMs: 1,
    })
  ).rejects.toThrow("unconfirmed");
  await expect(lifetime.complete()).rejects.toThrow("unconfirmed");
});

test("legacy recovery requires the observed PID and preserves stale completion", async () => {
  const opts = await fixture();
  const prior = await beginNativeProjectFinalization(opts);
  await prior.complete();
  const lifetime = await beginNativeProjectFinalization(opts);
  const {
    version: _version,
    pid: _pid,
    httpsPort: _port,
    ...identity
  } = lifetime.token.version === 2
    ? lifetime.token
    : { ...lifetime.token, pid: 0, httpsPort: null };
  const legacy = { version: 1 as const, ...identity };
  const active = join(
    opts.scope.nativeHome,
    ".hack-local/frontend-finalization",
    legacy.scope,
    legacy.run,
    "active.json"
  );
  await writeFile(active, JSON.stringify(legacy));
  expect(await captureNativeProjectFinalization(opts)).toEqual(legacy);
  const recovery = {
    ...opts,
    token: legacy,
    expectAttempt: legacy.attempt,
    verifyEffects: async () => undefined,
    isDead: () => true,
  };
  await expect(recoverNativeProjectFinalization(recovery)).rejects.toThrow(
    "unconfirmed"
  );
  await recoverNativeProjectFinalization({ ...recovery, legacyPid: 52_141 });
  await waitNativeProjectFinalization({ ...opts, token: legacy, timeoutMs: 1 });
});
