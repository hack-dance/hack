import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginNativeProjectFinalization,
  captureNativeProjectFinalization,
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
