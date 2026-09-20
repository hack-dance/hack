import { afterEach, test as bunTest, expect } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const owner = process.env.HACK_MCP_OWNER_TEST_BINARY;
const test = bunTest.skipIf(!owner);
const roots: string[] = [];
const children: Bun.Subprocess[] = [];
const helpers = new Set<number>();

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
  for (const pid of helpers) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  helpers.clear();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitFor(check: () => Promise<boolean>, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) {
      throw new Error("Supervision fixture timed out");
    }
    await Bun.sleep(20);
  }
}

async function fixture(body: string) {
  if (!owner) {
    throw new Error("Explicit native owner required");
  }
  const root = await realpath(await mkdtemp("/tmp/hack-mw-"));
  roots.push(root);
  await chmod(root, 0o700);
  const script = join(root, "backend.ts");
  await writeFile(
    script,
    `#!${process.execPath}\nimport { writeFileSync, readSync, writeSync } from "node:fs";\nconst fd = Number(process.env.HACK_MCP_STARTUP_FD);\nwriteFileSync("pid", String(process.pid));\n${body}\n`,
    { mode: 0o700 }
  );
  const started = Date.now();
  const child = Bun.spawn(
    [
      owner,
      "--supervise",
      "--directory",
      root,
      "--",
      script,
      root,
      "supervision-fixture",
    ],
    { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  );
  children.push(child);
  await waitFor(async () =>
    /^\d+$/.test(await readFile(join(root, "pid"), "utf8").catch(() => ""))
  );
  const pid = Number(await readFile(join(root, "pid"), "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error("Invalid fixture PID");
  }
  helpers.add(pid);
  return { root, child, pid, started, binary: owner };
}

test("supervisor times out and reaps its unready direct child", async () => {
  const { root, child, pid, started } = await fixture(
    "setInterval(() => {}, 1000);"
  );
  expect(await child.exited).toBe(1);
  expect(Date.now() - started).toBeGreaterThanOrEqual(7500);
  expect(Date.now() - started).toBeLessThan(11_000);
  expect(await new Response(child.stderr).text()).toContain("timed out");
  expect(() => process.kill(pid, 0)).toThrow();
  helpers.delete(pid);
  expect((await lstat(join(root, ".mcp-lease"))).size).toBe(0);
}, 15_000);

test("grant commits startup ownership and leaves no resident supervisor", async () => {
  const { root, child, pid } =
    await fixture(`writeFileSync("prefix", Bun.argv[2]);
writeSync(fd, Buffer.from("R"));
const response = Buffer.alloc(1);
if (readSync(fd, response) !== 1 || response[0] !== 71) process.exit(1);
writeFileSync("grant", response);
setInterval(() => {}, 1000);`);
  expect(await child.exited).toBe(0);
  expect(await readFile(join(root, "prefix"), "utf8")).toBe(
    "--startup-supervised-v2"
  );
  await waitFor(
    async () =>
      (await readFile(join(root, "grant")).catch(() => null))?.[0] === 71
  );
  expect(process.kill(pid, 0)).toBe(true);
  expect(await new Response(child.stderr).text()).toBe("");
});

test("invalid startup request is refused and reaped", async () => {
  const { child, pid } = await fixture(
    'writeSync(fd, Buffer.from("X")); setInterval(() => {}, 1000);'
  );
  expect(await child.exited).toBe(1);
  expect(() => process.kill(pid, 0)).toThrow();
  helpers.delete(pid);
});

test("timeout after receipt publication recovers only witnessed socket state", async () => {
  const backendModule = join(import.meta.dir, "../src/mcp/socket-backend.ts");
  const grantModule = join(import.meta.dir, "../src/mcp/startup-channel.ts");
  const { root, child, pid } =
    await fixture(`const { mock } = await import("bun:test");
mock.module(${JSON.stringify(grantModule)}, () => ({ createMcpStartupChannel() { return { check() {}, close() {}, request: () => new Promise(() => {}) }; } }));
const { startMcpSocketBackend } = await import(${JSON.stringify(backendModule)});
await startMcpSocketBackend({directory:process.cwd(), backendId:"timeout-fixture"});`);
  await waitFor(
    async () => await Bun.file(join(root, ".mcp-receipt.json")).exists()
  );
  expect(await child.exited).toBe(1);
  expect(() => process.kill(pid, 0)).toThrow();
  helpers.delete(pid);
  for (const name of ["mcp.sock", ".mcp-owner", ".mcp-receipt.json"]) {
    expect(await lstat(join(root, name)).catch(() => null)).toBeNull();
  }
}, 15_000);

test("loss of the supervisor refuses a backend's later grant request", async () => {
  const grantModule = join(import.meta.dir, "../src/mcp/startup-grant.ts");
  const { root, child, pid } =
    await fixture(`const { existsSync } = await import("node:fs");
while (!existsSync("request")) await Bun.sleep(10);
const { requireMcpStartupGrant } = await import(${JSON.stringify(grantModule)});
try { requireMcpStartupGrant(); writeFileSync("outcome", "granted"); }
catch { writeFileSync("outcome", "refused"); }
`);
  child.kill("SIGKILL");
  await child.exited;
  await writeFile(join(root, "request"), "go");
  await waitFor(async () => await Bun.file(join(root, "outcome")).exists());
  expect(await readFile(join(root, "outcome"), "utf8")).toBe("refused");
  await waitFor(async () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  helpers.delete(pid);
});

test("stopped supervisor cannot leave a published backend blocked on grant", async () => {
  const backendModule = join(import.meta.dir, "../src/mcp/socket-backend.ts");
  const { root, child, pid, binary } =
    await fixture(`const { existsSync } = await import("node:fs");
while (!existsSync("request")) await Bun.sleep(10);
const { startMcpSocketBackend } = await import(${JSON.stringify(backendModule)});
try {
 await startMcpSocketBackend({directory:process.cwd(), backendId:"stopped-fixture"});
 writeFileSync("outcome", "granted");
} catch { writeFileSync("outcome", "refused"); }
`);
  process.kill(child.pid, "SIGSTOP");
  await waitFor(async () => {
    const result = Bun.spawnSync(
      ["/bin/ps", "-o", "stat=", "-p", String(child.pid)],
      { stdout: "pipe", stderr: "pipe" }
    );
    return new TextDecoder().decode(result.stdout).includes("T");
  });
  const requested = Date.now();
  await writeFile(join(root, "request"), "go");
  await waitFor(
    async () => await Bun.file(join(root, ".mcp-receipt.json")).exists()
  );
  await waitFor(
    async () => await Bun.file(join(root, "outcome")).exists(),
    11_000
  );
  expect(await readFile(join(root, "outcome"), "utf8")).toBe("refused");
  expect(Date.now() - requested).toBeGreaterThanOrEqual(7500);
  for (const name of ["mcp.sock", ".mcp-owner", ".mcp-receipt.json"]) {
    expect(await lstat(join(root, name)).catch(() => null)).toBeNull();
  }
  // The stopped owner still holds its lease. Resume our fixture so it can reap
  // its child and release that authority; never steal a live owner's lease.
  process.kill(child.pid, "SIGCONT");
  expect(await child.exited).toBe(1);
  expect(() => process.kill(pid, 0)).toThrow();
  helpers.delete(pid);
  const replacement = Bun.spawn(
    [
      binary,
      "--directory",
      root,
      "--",
      process.execPath,
      "-e",
      "process.exit(0)",
    ],
    { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  );
  children.push(replacement);
  expect(await replacement.exited).toBe(0);
  expect(await new Response(replacement.stderr).text()).toBe("");
}, 16_000);

test("supervisor loss during claim creation cannot publish after late completion", async () => {
  const sourceRoot =
    process.env.HACK_MCP_EARLY_SOURCE_ROOT ?? join(import.meta.dir, "..");
  const backendModule = join(sourceRoot, "src/mcp/socket-backend.ts");
  const { root, child, pid, binary } =
    await fixture(`const { mock } = await import("bun:test");
const fs = await import("node:fs/promises");
const original = {...fs};
const { existsSync } = await import("node:fs");
mock.module("node:fs/promises", () => ({...original,
 mkdir: async (path, options) => {
  const result = await original.mkdir(path, options);
  if (String(path).endsWith("/.mcp-owner")) {
   writeFileSync("pending", "claim-created");
   while (!existsSync("continue")) await Bun.sleep(10);
  }
  return result;
 },
 chmod: async (path, mode) => {
  if (String(path).endsWith("/mcp.sock")) writeFileSync("late-publication", "bound");
  return original.chmod(path, mode);
 }
}));
const {startMcpSocketBackend} = await import(${JSON.stringify(backendModule)});
try { await startMcpSocketBackend({directory:process.cwd(), backendId:"early-loss"}); writeFileSync("outcome", "granted"); }
catch { writeFileSync("outcome", "refused"); }
`);
  await waitFor(async () => await Bun.file(join(root, "pending")).exists());
  child.kill("SIGKILL");
  await child.exited;
  // Let the startup socket report EOF while the deliberately delayed effect is
  // still pending. Releasing the barrier must not revive publication.
  await Bun.sleep(100);
  await writeFile(join(root, "continue"), "go");
  await waitFor(async () => await Bun.file(join(root, "outcome")).exists());
  expect(await readFile(join(root, "outcome"), "utf8")).toBe("refused");
  expect(await Bun.file(join(root, "late-publication")).exists()).toBe(false);
  for (const name of ["mcp.sock", ".mcp-owner", ".mcp-receipt.json"]) {
    expect(await lstat(join(root, name)).catch(() => null)).toBeNull();
  }
  await waitFor(async () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  helpers.delete(pid);
  const replacement = Bun.spawn(
    [
      binary,
      "--directory",
      root,
      "--",
      process.execPath,
      "-e",
      "process.exit(0)",
    ],
    { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" }
  );
  children.push(replacement);
  expect(await replacement.exited).toBe(0);
});

test("supervision prefix makes the legacy entrypoint refuse before publishing", async () => {
  const backendModule = join(import.meta.dir, "../src/mcp/socket-backend.ts");
  const { root, child, pid } =
    await fixture(`const { mkdirSync } = await import("node:fs");
mkdirSync("--startup-supervised-v2", {mode:0o700});
const [directory, backendId, idleTimeout] = Bun.argv.slice(2);
const { startMcpSocketBackend } = await import(${JSON.stringify(backendModule)});
try {
 await startMcpSocketBackend({directory, backendId, idleTimeoutMs: idleTimeout === undefined ? 60_000 : Number(idleTimeout)});
 writeFileSync("legacy", "published");
} catch { writeFileSync("legacy", "refused"); process.exit(1); }
`);
  expect(await child.exited).toBe(1);
  expect(await readFile(join(root, "legacy"), "utf8")).toBe("refused");
  expect(() => process.kill(pid, 0)).toThrow();
  helpers.delete(pid);
  for (const prefix of [root, join(root, "--startup-supervised-v2")]) {
    expect(await lstat(join(prefix, "mcp.sock")).catch(() => null)).toBeNull();
    expect(
      await lstat(join(prefix, ".mcp-owner")).catch(() => null)
    ).toBeNull();
  }
});

test("failed grant delivery cannot re-arm timeout killing", async () => {
  const { root, child, pid } =
    await fixture(`const { existsSync, closeSync } = await import("node:fs");
while (!existsSync("request")) await Bun.sleep(10);
writeSync(fd, Buffer.from("R")); closeSync(fd);
writeFileSync("closed", "yes");
setInterval(() => {}, 1000);`);
  process.kill(child.pid, "SIGSTOP");
  await waitFor(async () => {
    const result = Bun.spawnSync(
      ["/bin/ps", "-o", "stat=", "-p", String(child.pid)],
      { stdout: "pipe", stderr: "pipe" }
    );
    return new TextDecoder().decode(result.stdout).includes("T");
  });
  await writeFile(join(root, "request"), "go");
  await waitFor(async () => await Bun.file(join(root, "closed")).exists());
  process.kill(child.pid, "SIGCONT");
  const status = await child.exited;
  const diagnostic = await new Response(child.stderr).text();
  let alive = false;
  try {
    alive = process.kill(pid, 0);
  } catch {}
  expect({ status, diagnostic, alive }).toEqual({
    status: 0,
    diagnostic: "",
    alive: true,
  });
});
