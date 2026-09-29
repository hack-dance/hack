import { afterEach, test as bunTest, expect } from "bun:test";
import {
  chmod,
  link,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

const binary = process.env.HACK_MCP_OWNER_TEST_BINARY;
const test = bunTest.skipIf(!binary);
const roots: string[] = [];
const children: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await realpath(await mkdtemp("/tmp/hack-mo-"));
  roots.push(root);
  await chmod(root, 0o700);
  const script = join(root, "backend.ts");
  await writeFile(
    script,
    `
import { fstatSync, appendFileSync } from "node:fs";
const fd = Number(process.env.HACK_MCP_LEASE_FD);
const lease = fstatSync(fd);
const code = 'try {const s=require("node:fs").fstatSync('+fd+'); console.log(JSON.stringify({dev:s.dev,ino:s.ino}));}catch{console.log("null")}';
const child = Bun.spawnSync([process.execPath, "-e", code], {stdout:"pipe"});
appendFileSync("winner", JSON.stringify({pid:process.pid,dev:lease.dev,ino:lease.ino,child:JSON.parse(new TextDecoder().decode(child.stdout))})+"\\n");
setInterval(() => {}, 1000);
`
  );
  return { root, script };
}

function spawn(root: string, args: string[]) {
  if (!binary) {
    throw new Error("Explicit native owner binary required");
  }
  const child = Bun.spawn([binary, "--directory", root, "--", ...args], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(child);
  return child;
}

async function winner(root: string) {
  const path = join(root, "winner");
  const deadline = Date.now() + 3000;
  while (!(await Bun.file(path).exists()) && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  return JSON.parse((await readFile(path, "utf8")).trim());
}

async function exited(child: Bun.Subprocess) {
  const deadline = Date.now() + 3000;
  while (child.exitCode === null && Date.now() < deadline) {
    await Bun.sleep(10);
  }
  expect(child.exitCode).not.toBeNull();
  return child.exitCode;
}

test("native owner transfers its stable lease across exec and excludes spawned commands", async () => {
  const { root, script } = await fixture();
  const first = spawn(root, [process.execPath, script]);
  const receipt = await winner(root);
  const before = await lstat(join(root, ".mcp-lease"));
  expect(receipt).toMatchObject({
    pid: first.pid,
    dev: before.dev,
    ino: before.ino,
  });
  expect(receipt.child).not.toEqual({ dev: before.dev, ino: before.ino });
  const second = spawn(root, [process.execPath, script]);
  expect(await exited(second)).toBe(1);
  expect(await new Response(second.stderr).text()).toContain(
    "ownership is busy"
  );
  expect(first.exitCode).toBeNull();
  first.kill("SIGKILL");
  await first.exited;
  await rm(join(root, "winner"));
  const replacement = spawn(root, [process.execPath, script]);
  expect((await winner(root)).pid).toBe(replacement.pid);
  const after = await lstat(join(root, ".mcp-lease"));
  expect({ dev: after.dev, ino: after.ino, size: after.size }).toEqual({
    dev: before.dev,
    ino: before.ino,
    size: 0,
  });
});

test("sixteen concurrent owners admit exactly one backend", async () => {
  const { root, script } = await fixture();
  const contenders = Array.from({ length: 16 }, () =>
    spawn(root, [process.execPath, script])
  );
  const receipt = await winner(root);
  const deadline = Date.now() + 3000;
  while (
    contenders.filter((child) => child.exitCode !== null).length < 15 &&
    Date.now() < deadline
  ) {
    await Bun.sleep(10);
  }
  expect(
    contenders
      .filter((child) => child.exitCode === null)
      .map((child) => child.pid)
  ).toEqual([receipt.pid]);
  expect(contenders.filter((child) => child.exitCode === 1)).toHaveLength(15);
  expect(
    (await readFile(join(root, "winner"), "utf8")).trim().split("\n")
  ).toHaveLength(1);
});

test("failed exec releases the lease without removing or replacing its inode", async () => {
  const { root, script } = await fixture();
  const failed = spawn(root, [join(root, "missing")]);
  expect(await exited(failed)).toBe(1);
  const before = await lstat(join(root, ".mcp-lease"));
  const next = spawn(root, [process.execPath, script]);
  expect((await winner(root)).pid).toBe(next.pid);
  expect((await lstat(join(root, ".mcp-lease"))).ino).toBe(before.ino);
});

for (const kind of ["symlink", "hardlink", "public", "content"] as const) {
  test(`native lease refuses ${kind} state without changing it`, async () => {
    const { root, script } = await fixture();
    const target = join(root, "foreign");
    await writeFile(target, "preserve", { mode: 0o600 });
    const lease = join(root, ".mcp-lease");
    if (kind === "symlink") {
      await symlink(target, lease);
    } else if (kind === "hardlink") {
      await link(target, lease);
    } else {
      await writeFile(lease, kind === "content" ? "preserve" : "", {
        mode: kind === "public" ? 0o644 : 0o600,
      });
    }
    const before = await lstat(lease);
    expect(await exited(spawn(root, [process.execPath, script]))).toBe(1);
    expect(await readFile(target, "utf8")).toBe("preserve");
    expect((await lstat(lease)).ino).toBe(before.ino);
    expect(await Bun.file(join(root, "winner")).exists()).toBe(false);
  });
}

test("real backend idle exit releases ownership for the next explicit start", async () => {
  const { root } = await fixture();
  const script = join(import.meta.dir, "../scripts/run-mcp-socket-backend.ts");
  for (let attempt = 0; attempt < 2; attempt++) {
    const backendBinary = process.env.HACK_MCP_BACKEND_TEST_BINARY;
    const args = [
      ...(backendBinary ? [backendBinary] : [process.execPath, script]),
      root,
      "owned-backend",
      "500",
    ];
    const child = spawn(root, args);
    const readyDeadline = Date.now() + 3000;
    while (
      !(await lstat(join(root, "mcp.sock")).catch(() => null)) &&
      child.exitCode === null &&
      Date.now() < readyDeadline
    ) {
      await Bun.sleep(10);
    }
    expect(
      await lstat(join(root, "mcp.sock")).catch(() => null)
    ).not.toBeNull();
    const duplicate = spawn(root, args);
    expect(await exited(duplicate)).toBe(1);
    expect(await new Response(duplicate.stderr).text()).toContain(
      "ownership is busy"
    );
    expect(await exited(child)).toBe(0);
    expect(await new Response(child.stderr).text()).toBe("");
    expect(JSON.parse(await new Response(child.stdout).text()).backendId).toBe(
      "owned-backend"
    );
    expect(await lstat(join(root, "mcp.sock")).catch(() => null)).toBeNull();
    expect(await lstat(join(root, ".mcp-owner")).catch(() => null)).toBeNull();
  }
});

async function crashedBackend() {
  const { root } = await fixture();
  const backendBinary = process.env.HACK_MCP_BACKEND_TEST_BINARY;
  const args = [
    ...(backendBinary
      ? [backendBinary]
      : [
          process.execPath,
          join(import.meta.dir, "../scripts/run-mcp-socket-backend.ts"),
        ]),
    root,
    "recovery",
    "0",
  ];
  const child = spawn(root, args);
  const receiptPath = join(root, ".mcp-receipt.json");
  const deadline = Date.now() + 3000;
  let receipt: string | undefined;
  while (Date.now() < deadline && child.exitCode === null) {
    receipt = await readFile(receiptPath, "utf8").catch(() => undefined);
    if (receipt?.endsWith("\n")) {
      break;
    }
    await Bun.sleep(10);
  }
  expect(receipt).toBeDefined();
  expect(JSON.parse(receipt ?? "null").version).toBe(1);
  child.kill("SIGKILL");
  await child.exited;
  return { root, args, receiptPath, receipt };
}

test("owner recovers witnessed state after SIGKILL and concurrent restarts select one backend", async () => {
  const { root, args, receiptPath, receipt } = await crashedBackend();
  const contenders = Array.from({ length: 8 }, () => spawn(root, args));
  const deadline = Date.now() + 3000;
  while (
    contenders.filter((child) => child.exitCode !== null).length < 7 &&
    Date.now() < deadline
  ) {
    await Bun.sleep(10);
  }
  expect(contenders.filter((child) => child.exitCode === null)).toHaveLength(1);
  expect(contenders.filter((child) => child.exitCode === 1)).toHaveLength(7);
  let current = receipt;
  while (
    (!current?.endsWith("\n") || current === receipt) &&
    Date.now() < deadline
  ) {
    await Bun.sleep(10);
    current = await readFile(receiptPath, "utf8").catch(() => undefined);
  }
  expect(JSON.parse(current ?? "null").version).toBe(1);
  const live = contenders.find((child) => child.exitCode === null);
  expect(live).toBeDefined();
  live?.kill("SIGTERM");
  if (live) {
    expect(await exited(live)).toBe(0);
  }
  expect(await lstat(receiptPath).catch(() => null)).toBeNull();
});

for (const stage of ["socket-removed", "claim-removed"] as const) {
  test(`recovery resumes after ${stage}`, async () => {
    const { root, args, receiptPath } = await crashedBackend();
    await rm(join(root, "mcp.sock"));
    if (stage === "claim-removed") {
      await rm(join(root, ".mcp-owner"), { recursive: true });
    }
    const next = spawn(root, [...args.slice(0, -1), "100"]);
    expect(await exited(next)).toBe(0);
    expect(await lstat(receiptPath).catch(() => null)).toBeNull();
    expect(await lstat(join(root, "mcp.sock")).catch(() => null)).toBeNull();
  });
}

for (const corruption of [
  "missing-receipt",
  "socket-replaced",
  "extra-claim-content",
  "malformed-receipt",
  "wrong-lease",
  "oversized-receipt",
  "aliased-receipt",
] as const) {
  test(`recovery preserves ambiguous ${corruption}`, async () => {
    const { root, args, receiptPath, receipt } = await crashedBackend();
    if (corruption === "missing-receipt") {
      await rm(receiptPath);
    }
    if (corruption === "socket-replaced") {
      await rm(join(root, "mcp.sock"));
      await writeFile(join(root, "mcp.sock"), "foreign");
    }
    if (corruption === "extra-claim-content") {
      await writeFile(join(root, ".mcp-owner", "foreign"), "preserve");
    }
    if (corruption === "malformed-receipt") {
      await writeFile(receiptPath, "invalid");
    }
    if (corruption === "oversized-receipt") {
      await writeFile(receiptPath, "x".repeat(4097));
    }
    if (corruption === "aliased-receipt") {
      await link(receiptPath, join(root, "receipt-alias"));
    }
    if (corruption === "wrong-lease") {
      const value = JSON.parse(receipt ?? "null");
      value.lease.ino = "0";
      await writeFile(receiptPath, JSON.stringify(value));
    }
    const before = await lstat(join(root, "mcp.sock"));
    const contents = await readFile(receiptPath, "utf8").catch(() => undefined);
    expect(await exited(spawn(root, args))).toBe(1);
    expect((await lstat(join(root, "mcp.sock"))).ino).toBe(before.ino);
    expect(await readFile(receiptPath, "utf8").catch(() => undefined)).toBe(
      contents
    );
    expect((await lstat(join(root, ".mcp-owner"))).isDirectory()).toBe(true);
  });
}
