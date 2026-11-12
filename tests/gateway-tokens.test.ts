import { afterEach, expect, test } from "bun:test";
import {
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
