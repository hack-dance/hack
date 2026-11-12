import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { authenticateGatewayRequest } from "../src/control-plane/extensions/gateway/auth.ts";
import {
  createGatewayToken,
  listGatewayTokens,
  revokeGatewayToken,
  verifyGatewayToken,
} from "../src/control-plane/extensions/gateway/tokens.ts";

let rootDir: string | null = null;

afterEach(async () => {
  if (!rootDir) {
    return;
  }
  await rm(rootDir, { recursive: true, force: true });
  rootDir = null;
});

test("gateway tokens can be created, verified, and revoked", async () => {
  rootDir = await mkdtemp(join(tmpdir(), "hack-gateway-"));

  const issued = await createGatewayToken({ rootDir, label: "phone" });
  const tokens = await listGatewayTokens({ rootDir });
  expect(tokens.length).toBe(1);
  expect(tokens[0]?.id).toBe(issued.record.id);
  expect(tokens[0]?.scope).toBe("read");

  const verified = await verifyGatewayToken({ rootDir, token: issued.token });
  expect(verified?.id).toBe(issued.record.id);
  expect(verified?.lastUsedAt).toBeTruthy();
  expect(verified?.scope).toBe("read");

  const revoked = await revokeGatewayToken({
    rootDir,
    tokenId: issued.record.id,
  });
  expect(revoked).toBe(true);
  const verifiedAfter = await verifyGatewayToken({
    rootDir,
    token: issued.token,
  });
  expect(verifiedAfter).toBeNull();
});

test("gateway auth accepts bearer and x-hack-token headers", async () => {
  rootDir = await mkdtemp(join(tmpdir(), "hack-gateway-"));

  const issued = await createGatewayToken({
    rootDir,
    label: "agent",
    scope: "write",
  });
  const bearerHeaders = new Headers({
    authorization: `Bearer ${issued.token}`,
  });
  const bearerAuth = await authenticateGatewayRequest({
    rootDir,
    headers: bearerHeaders,
  });
  expect(bearerAuth.ok).toBe(true);
  if (bearerAuth.ok) {
    expect(bearerAuth.scope).toBe("write");
  }

  const altHeaders = new Headers({
    "x-hack-token": issued.token,
  });
  const altAuth = await authenticateGatewayRequest({
    rootDir,
    headers: altHeaders,
  });
  expect(altAuth.ok).toBe(true);

  const missingAuth = await authenticateGatewayRequest({
    rootDir,
    headers: new Headers(),
  });
  expect(missingAuth.ok).toBe(false);
  if (!missingAuth.ok) {
    expect(missingAuth.reason).toBe("missing");
  }
});

test("gateway auth accepts query token when allowed", async () => {
  rootDir = await mkdtemp(join(tmpdir(), "hack-gateway-"));

  const issued = await createGatewayToken({
    rootDir,
    label: "web",
    scope: "write",
  });
  const url = new URL(
    "http://127.0.0.1:7788/control-plane/projects/abc/shells/123/stream"
  );
  url.searchParams.set("token", issued.token);

  const auth = await authenticateGatewayRequest({
    rootDir,
    headers: new Headers(),
    url,
    allowQueryToken: true,
  });
  expect(auth.ok).toBe(true);

  const denied = await authenticateGatewayRequest({
    rootDir,
    headers: new Headers(),
    url,
    allowQueryToken: false,
  });
  expect(denied.ok).toBe(false);
  if (!denied.ok) {
    expect(denied.reason).toBe("missing");
  }
});

test("the token store is never written through a planted link (HACK-2142)", async () => {
  // Reviewer: Bun.write follows a symlink, so a link planted in a once
  // group-writable gateway/ had its target overwritten by the token JSON.
  rootDir = await mkdtemp(join(tmpdir(), "hack-gateway-"));
  const gateway = join(rootDir, "gateway");
  await mkdir(gateway, { recursive: true });
  const victim = join(rootDir, "victim.txt");
  await writeFile(victim, "keep\n");
  await symlink(victim, join(gateway, "tokens.json"));
  await expect(createGatewayToken({ rootDir, label: "phone" })).rejects.toThrow(
    "not a plain file"
  );
  expect(await readFile(victim, "utf8")).toBe("keep\n");
  // A normal store is written owner-only, with no temp file left behind.
  await rm(join(gateway, "tokens.json"));
  await createGatewayToken({ rootDir, label: "phone" });
  expect((await stat(join(gateway, "tokens.json"))).mode & 0o777).toBe(0o600);
  expect(await readdir(gateway)).toEqual(["tokens.json"]);
  expect((await listGatewayTokens({ rootDir })).length).toBe(1);
});

test("a token store others could write is not used (HACK-2142)", async () => {
  // Codex security review: a 0664 store (written before 0600 stores, under
  // umask 0002) could hold a planted write token's hash.
  rootDir = await mkdtemp(join(tmpdir(), "hack-gateway-"));
  const issued = await createGatewayToken({ rootDir, label: "phone" });
  const store = join(rootDir, "gateway", "tokens.json");
  await chmod(store, 0o664);
  await expect(listGatewayTokens({ rootDir })).rejects.toThrow(
    `rm ${store} && hack x gateway token-create`
  );
  await expect(createGatewayToken({ rootDir, label: "again" })).rejects.toThrow(
    "cannot be trusted"
  );
  // Authentication grants nothing from it (and does not throw).
  const denied = await authenticateGatewayRequest({
    rootDir,
    headers: new Headers({ authorization: `Bearer ${issued.token}` }),
  });
  expect(denied.ok).toBe(false);
  // After the documented recovery, tokens work again.
  await rm(store);
  const reissued = await createGatewayToken({ rootDir, label: "phone" });
  const allowed = await authenticateGatewayRequest({
    rootDir,
    headers: new Headers({ authorization: `Bearer ${reissued.token}` }),
  });
  expect(allowed.ok).toBe(true);
});

test("the token store is read through one open that neither follows a link nor blocks (HACK-2142)", async () => {
  // Reviewer: checking the path and then reading it again left a gap; the
  // store is now checked and read through the same no-follow open, which
  // also must not hang on a planted FIFO.
  rootDir = await mkdtemp(join(tmpdir(), "hack-gateway-"));
  const gateway = join(rootDir, "gateway");
  await mkdir(gateway, { recursive: true, mode: 0o700 });
  const store = join(gateway, "tokens.json");
  const fifo = Bun.spawnSync(["mkfifo", store]);
  expect(fifo.exitCode).toBe(0);
  await expect(listGatewayTokens({ rootDir })).rejects.toThrow(
    "is not a plain file"
  );
  await rm(store);
  const victim = join(rootDir, "victim.json");
  await writeFile(victim, '{"version":1,"tokens":[]}\n', { mode: 0o600 });
  await symlink(victim, store);
  await expect(listGatewayTokens({ rootDir })).rejects.toThrow(
    "is not a plain file"
  );
});
