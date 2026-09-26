import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const harnessPath = resolve(import.meta.dir, "e2e/harness.ts");

/** Keep the CLI-bin override and isolated HOME inside a disposable driver. */
async function runDriver(body: string): Promise<void> {
  const root = await mkdtemp(resolve(tmpdir(), "hack-e2e-stream-test-"));
  const driver = `
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
const { runCli, runCommand } = await import(${JSON.stringify(harnessPath)});
const root = ${JSON.stringify(root)};
const until = async (check) => {
  const deadline = Date.now() + 2000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "live observation deadline exceeded");
    await Bun.sleep(10);
  }
};
${body}
console.log("driver passed");
`;
  const child = Bun.spawn([process.execPath, "-e", driver], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      TMPDIR: root,
      HACK_E2E_CLI_BIN: process.execPath,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 8000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(stdout.trim()).toBe("driver passed");
  } finally {
    clearTimeout(timer);
    child.kill();
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}

test("concurrent CLI capture stays isolated and stderr arrives before held exits", async () => {
  await runDriver(`
const release = join(root, "release");
const observed = ["", ""];
const complete = [false, false];
const jobs = ["alpha", "beta"].map((marker, index) => {
  const source = 'process.stderr.write(' + JSON.stringify(marker + " progress\\n") + '); ' +
    'const deadline = Date.now() + 3000; ' +
    'while (!(await Bun.file(' + JSON.stringify(release) + ').exists())) {' +
    'if (Date.now() > deadline) process.exit(75); await Bun.sleep(10); } ' +
    'process.stdout.write(' + JSON.stringify(marker) + ');';
  return runCli({ hackHome: root, invocation: {
    cwd: root, args: ["-e", source], timeoutMs: 4000,
    onStderrChunk: (chunk) => { observed[index] += chunk; },
  }}).then((result) => { complete[index] = true; return result; });
});
try {
  await until(() => observed[0] === "alpha progress\\n" && observed[1] === "beta progress\\n");
  assert.deepEqual(complete, [false, false], "callbacks must arrive while exits are held");
} finally {
  await Bun.write(release, "release\\n");
}
const results = await Promise.all(jobs);
for (const [index, marker] of ["alpha", "beta"].entries()) {
  assert.equal(results[index].exitCode, 0);
  assert.equal(results[index].timedOut, false);
  assert.equal(results[index].stdout, marker);
  assert.equal(results[index].stderr, marker + " progress\\n");
}
const files = await readdir(join(root, ".e2e-capture"));
const outFiles = files.filter((name) => name.endsWith(".out"));
const errFiles = files.filter((name) => name.endsWith(".err"));
assert.equal(outFiles.length, 2, "each concurrent invocation needs its own stdout capture");
assert.equal(errFiles.length, 2, "each concurrent invocation needs its own stderr capture");
assert.deepEqual((await Promise.all(outFiles.map((name) => Bun.file(join(root, ".e2e-capture", name)).text()))).sort(), ["alpha", "beta"]);
`);
}, 12_000);

test("plain command callback observes live stderr and preserves final output", async () => {
  await runDriver(`
let observed = "";
let complete = false;
const release = join(root, "release");
const source = 'process.stderr.write("plain-progress"); const deadline = Date.now() + 3000; ' +
  'while (!(await Bun.file(' + JSON.stringify(release) + ').exists())) {' +
  'if (Date.now() > deadline) process.exit(75); await Bun.sleep(10); } process.stdout.write("plain-output");';
const job = runCommand({ argv: [process.execPath, "-e", source], cwd: root, timeoutMs: 4000,
  onStderrChunk: (chunk) => { observed += chunk; },
}).then((result) => { complete = true; return result; });
try {
  await until(() => observed === "plain-progress");
  assert.equal(complete, false);
} finally { await Bun.write(release, "release\\n"); }
const result = await job;
assert.equal(result.exitCode, 0);
assert.equal(result.timedOut, false);
assert.equal(result.stdout, "plain-output");
assert.equal(result.stderr, "plain-progress");
`);
}, 12_000);

test("CLI callback rejection waits for the owned child to exit", async () => {
  await runDriver(`
const finished = join(root, "child-finished");
const source = 'process.stderr.write("observed"); await Bun.sleep(100); await Bun.write(' + JSON.stringify(finished) + ', "finished");';
await assert.rejects(runCli({ hackHome: root, invocation: {
  cwd: root, args: ["-e", source], timeoutMs: 2000,
  onStderrChunk: () => { throw new Error("observer failure"); },
}}), /observer failure/);
assert.equal(await Bun.file(finished).text(), "finished");
`);
}, 12_000);
