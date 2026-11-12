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
import { nativeFrontendGone } from "../src/backends/native-frontend-identity.ts";
import {
  beginNativeProjectFinalization,
  captureNativeProjectFinalization,
  isNativeProjectFinalizationToken,
  recoverNativeProjectFinalization,
  waitNativeProjectFinalization,
} from "../src/backends/native-project-finalization.ts";
import { expectClosedRefusal } from "./helpers/closed-refusal.ts";

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
    await expectClosedRefusal(
      beginNativeProjectFinalization({
        ...opts,
        httpsPort: 18_443,
        httpsLease: invalid,
      }),
      "unconfirmed"
    );
  }
  await expectClosedRefusal(
    beginNativeProjectFinalization({
      ...opts,
      httpsPort: null,
      httpsLease: lease,
    }),
    "unconfirmed"
  );
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
  await expectClosedRefusal(
    waitNativeProjectFinalization({
      ...opts,
      token: second.token,
      timeoutMs: 1,
    }),
    "unconfirmed"
  );
  await expectClosedRefusal(first.complete(), "unconfirmed");
  if (second.token.version !== 3) {
    throw new Error("expected v3 finalizer");
  }
  const forged = {
    ...second.token,
    httpsLease: { ...second.token.httpsLease, leaseId: "6".repeat(32) },
  };
  expect(isNativeProjectFinalizationToken(forged)).toBe(true);
  await expectClosedRefusal(
    waitNativeProjectFinalization({ ...opts, token: forged, timeoutMs: 1 }),
    "unconfirmed"
  );
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
  await expectClosedRefusal(
    recoverNativeProjectFinalization({
      ...recovery,
      token: {
        ...lifetime.token,
        httpsLease: {
          ...lifetime.token.httpsLease,
          ownerGeneration: "f".repeat(32),
        },
      },
    }),
    "unconfirmed"
  );
  expect(observations).toBe(0);
  await expect(
    recoverNativeProjectFinalization({
      ...recovery,
      verifyEffects: async () => {
        throw new Error("lease recovery uncertain");
      },
    })
  ).rejects.toThrow("lease recovery uncertain");
  await expectClosedRefusal(
    waitNativeProjectFinalization({
      ...opts,
      token: lifetime.token,
      timeoutMs: 1,
    }),
    "unconfirmed"
  );
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
  await expectClosedRefusal(
    waitNativeProjectFinalization({ ...opts, token, timeoutMs: 1 }),
    "unconfirmed"
  );
  await lifetime.complete();
  await waitNativeProjectFinalization({ ...opts, token, timeoutMs: 1 });
});
test("same-run restore cannot reuse stale acknowledgement or supersede incomplete owner", async () => {
  const opts = await fixture();
  const old = await beginNativeProjectFinalization(opts);
  await expectClosedRefusal(
    beginNativeProjectFinalization(opts),
    "unconfirmed"
  );
  await old.complete();
  const next = await beginNativeProjectFinalization(opts);
  expect(next.token.attempt).not.toBe(old.token.attempt);
  await expectClosedRefusal(
    waitNativeProjectFinalization({ ...opts, token: next.token, timeoutMs: 1 }),
    "unconfirmed"
  );
  await expectClosedRefusal(old.complete(), "unconfirmed");
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
  await expectClosedRefusal(
    recoverNativeProjectFinalization({
      ...recovery,
      expectAttempt: "f".repeat(32),
      isDead: () => true,
    }),
    "unconfirmed"
  );
  await expectClosedRefusal(
    recoverNativeProjectFinalization({
      ...recovery,
      isDead: () => false,
    }),
    "unconfirmed"
  );
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
  await expectClosedRefusal(
    waitNativeProjectFinalization({
      ...opts,
      token: lifetime.token,
      timeoutMs: 1,
    }),
    "unconfirmed"
  );
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
  await expectClosedRefusal(
    waitNativeProjectFinalization({
      ...opts,
      token: lifetime.token,
      timeoutMs: 1,
    }),
    "unconfirmed"
  );
  await expectClosedRefusal(lifetime.complete(), "unconfirmed");
});

test("macOS birth-bound recovery rejects changed tokens and rechecks exit proof after effects", async () => {
  const opts = await fixture();
  const lifetime = await beginNativeProjectFinalization(opts);
  const birth = "Wed Nov 11 17:23:26 2026";
  const token = {
    ...lifetime.token,
    version: 2 as const,
    pid: process.pid,
    birth,
    httpsPort: null,
  };
  const base = join(opts.scope.nativeHome, ".hack-local/frontend-finalization");
  const [hash] = await readdir(base);
  const active = join(base, hash!, opts.run.run, "active.json");
  await writeFile(active, JSON.stringify(token), { mode: 0o600 });
  expect(await captureNativeProjectFinalization(opts)).toEqual(token);
  for (const changed of ["", "bad", 123]) {
    expect(isNativeProjectFinalizationToken({ ...token, birth: changed })).toBe(
      false
    );
  }
  let observedBirth = "Thu Nov 12 17:23:26 2026";
  const isDead = () =>
    nativeFrontendGone(token, {
      platform: "darwin",
      absent: () => false,
      observe: async () => ({
        uid: process.getuid?.() ?? 0,
        birth: observedBirth,
        zombie: false,
      }),
    });
  const recovery = { ...opts, token, expectAttempt: token.attempt, isDead };
  await expectClosedRefusal(
    recoverNativeProjectFinalization({
      ...recovery,
      verifyEffects: async () => {
        observedBirth = birth;
      },
    }),
    "unconfirmed"
  );
  observedBirth = "Thu Nov 12 17:23:26 2026";
  await expectClosedRefusal(
    recoverNativeProjectFinalization({
      ...recovery,
      verifyEffects: async () => {
        await writeFile(
          active,
          JSON.stringify({ ...token, birth: observedBirth })
        );
      },
    }),
    "unconfirmed"
  );
  await writeFile(active, JSON.stringify(token));
  await recoverNativeProjectFinalization({
    ...recovery,
    verifyEffects: async () => {},
  });
  await waitNativeProjectFinalization({ ...opts, token, timeoutMs: 1 });
  await expectClosedRefusal(lifetime.complete(), "unconfirmed");
});

test("a frontend completing between the completion read and exit observation is a clean stop", async () => {
  const opts = await fixture();
  const lifetime = await beginNativeProjectFinalization(opts);
  let reads = 0;
  await waitNativeProjectFinalization({
    ...opts,
    token: lifetime.token,
    timeoutMs: 1000,
    isGone: async () => {
      reads++;
      await lifetime.complete();
      return true;
    },
  });
  expect(reads).toBe(1);
});

test("frontend wait polls ESRCH frequently but throttles birth inspection", async () => {
  const opts = await fixture();
  const lifetime = await beginNativeProjectFinalization(opts);
  let polls = 0;
  let births = 0;
  await waitNativeProjectFinalization({
    ...opts,
    token: lifetime.token,
    timeoutMs: 2000,
    isGone: async (_, io) => {
      polls++;
      births += Number(io?.inspectBirth);
      if (polls === 3) {
        await lifetime.complete();
      }
      return false;
    },
  });
  expect(polls).toBe(3);
  expect(births).toBe(1);
});

test.each([
  undefined,
  "Wed Nov 11 17:23:26 2026",
])("legacy recovery requires the observed PID and preserves stale completion (birth=%s)", async (birth) => {
  const opts = await fixture();
  const prior = await beginNativeProjectFinalization(opts);
  await prior.complete();
  const lifetime = await beginNativeProjectFinalization(opts);
  const modern = {
    version: 2 as const,
    attempt: lifetime.token.attempt,
    scope: lifetime.token.scope,
    run: lifetime.token.run,
    owner: lifetime.token.owner,
    namespace: lifetime.token.namespace,
    planId: lifetime.token.planId,
    pid: process.pid,
    httpsPort: null,
    ...(birth === undefined ? {} : { birth }),
  };
  const legacy = {
    version: 1 as const,
    attempt: modern.attempt,
    scope: modern.scope,
    run: modern.run,
    owner: modern.owner,
    namespace: modern.namespace,
    planId: modern.planId,
  };
  const active = join(
    opts.scope.nativeHome,
    ".hack-local/frontend-finalization",
    legacy.scope,
    legacy.run,
    "active.json"
  );
  await writeFile(active, JSON.stringify(modern));
  expect(await captureNativeProjectFinalization(opts)).toEqual(modern);
  expect(
    isNativeProjectFinalizationToken({
      ...legacy,
      birth: "Wed Nov 11 17:23:26 2026",
    })
  ).toBe(false);
  await writeFile(active, JSON.stringify(legacy));
  expect(await captureNativeProjectFinalization(opts)).toEqual(legacy);
  const recovery = {
    ...opts,
    token: legacy,
    expectAttempt: legacy.attempt,
    verifyEffects: async () => undefined,
    isDead: () => true,
  };
  await expectClosedRefusal(
    recoverNativeProjectFinalization(recovery),
    "unconfirmed"
  );
  await recoverNativeProjectFinalization({ ...recovery, legacyPid: 52_141 });
  await waitNativeProjectFinalization({ ...opts, token: legacy, timeoutMs: 1 });
});
