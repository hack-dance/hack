import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { exec } from "../src/lib/shell.ts";
import { privateCliEnv, privateCliRunEnv } from "./helpers/private-cli-env.ts";

const roots: string[] = [];
const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hack-bounded-capture-"));
  roots.push(root);
  return root;
}

test("bounded capture drains stdout and stderr concurrently without losing a successful result", async () => {
  const root = await fixture();
  const result = await exec(
    [
      process.execPath,
      "-e",
      'process.stdout.write("o".repeat(32000));process.stderr.write("e".repeat(2000));',
    ],
    {
      cwd: root,
      ...privateCliRunEnv({ root }),
      stdin: "ignore",
      timeoutMs: 2000,
      maxStdoutBytes: 65_536,
      maxStderrBytes: 4096,
      forwardSignals: true,
    }
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toHaveLength(32_000);
  expect(result.stderr).toHaveLength(2000);
});

test("stderr overflow kills and settles the owned capture rather than returning an image-like partial diagnostic", async () => {
  const root = await fixture();
  const result = await exec(
    [
      process.execPath,
      "-e",
      'process.stdout.write("o".repeat(32000));process.stderr.write("e".repeat(32000));setInterval(()=>{},1000);',
    ],
    {
      cwd: root,
      ...privateCliRunEnv({ root }),
      stdin: "ignore",
      timeoutMs: 3000,
      maxStdoutBytes: 65_536,
      maxStderrBytes: 4096,
      forwardSignals: true,
    }
  );
  expect(result).toEqual({ exitCode: 125, stdout: "", stderr: "" });
});

test("bounded read-only capture forwards TERM and settles resistant group members before returning", async () => {
  const root = await fixture();
  const ready = join(root, "ready");
  const receipt = join(root, "receipt.json");
  const driver = join(root, "driver.ts");
  const script = `trap '' TERM INT; (trap '' TERM INT; sleep 30) & printf '%s %s\\n' "$$" "$!" > "$1"; wait`;
  await writeFile(
    driver,
    `import {exec} from ${JSON.stringify(resolve("src/lib/shell.ts"))};const result=await exec(["/bin/sh","-c",${JSON.stringify(script)},"sh",${JSON.stringify(ready)}],{stdin:"ignore",timeoutMs:5000,maxStdoutBytes:65536,maxStderrBytes:4096,forwardSignals:true});await Bun.write(${JSON.stringify(receipt)},JSON.stringify(result));`
  );
  const child = Bun.spawn([process.execPath, driver], {
    cwd: root,
    env: privateCliEnv({ root }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  children.push(child);
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const deadline = Date.now() + 3000;
  while (
    !(await Bun.file(ready).exists()) &&
    Date.now() < deadline &&
    child.exitCode === null
  ) {
    await Bun.sleep(10);
  }
  expect(await Bun.file(ready).exists()).toBe(true);
  const pids = (await readFile(ready, "utf8")).trim().split(" ").map(Number);
  const started = Date.now();
  child.kill("SIGTERM");
  const [stdout, stderr, code] = await output;
  expect(code, stdout + stderr).toBe(0);
  expect(Date.now() - started).toBeLessThan(4500);
  expect(await Bun.file(receipt).json()).toEqual({
    exitCode: 143,
    stdout: "",
    stderr: "",
  });
  for (const pid of pids) {
    const probe = Bun.spawn(["/bin/ps", "-o", "stat=", "-p", String(pid)], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
    const state = (await new Response(probe.stdout).text()).trim();
    await probe.exited;
    expect(state === "" || state.startsWith("Z")).toBe(true);
  }
}, 12_000);
