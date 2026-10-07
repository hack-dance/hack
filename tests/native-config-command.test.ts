import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let directory = "";
const root = resolve(import.meta.dir, "..");
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "hack-native-config-command-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function startCli(opts: { compilerBody: string; json?: boolean }) {
  const compiler = join(directory, "compiler");
  const file = join(directory, "input.json");
  await Bun.write(file, '{"schema_version":1,"name":"example"}');
  await Bun.write(
    compiler,
    `#!${process.execPath}\nif (process.argv[2] === '--protocol') { console.log('{"transport_version":1,"authored_version":1,"plan_version":1}'); } else { ${opts.compilerBody} }`
  );
  await chmod(compiler, 0o755);
  return Bun.spawn(
    [
      process.execPath,
      join(root, "index.ts"),
      "config",
      "validate",
      "--file",
      file,
      ...(opts.json ? ["--json"] : []),
    ],
    {
      cwd: directory,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: directory,
        HACK_LOGGER: "console",
        HACK_CONFIG_COMPILER_BINARY: compiler,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
}

test("human diagnostics escape authored control characters", async () => {
  const response = {
    transport_version: 1,
    ok: false,
    diagnostics: [
      {
        code: "invalid_name",
        pointer: "/services/\u001b[2J\nforged",
        message: "Invalid name.",
        line: 1,
        column: 1,
      },
    ],
  };
  const child = await startCli({
    compilerBody: `console.log(${JSON.stringify(JSON.stringify(response))}); process.exitCode = 1;`,
  });
  const [stderr, exit] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exit).toBe(1);
  expect(stderr).toContain('"/services/\\u001b[2J\\nforged"');
  expect(stderr).not.toContain("\u001b[2J");
  expect(stderr).not.toContain("\nforged");
});

test.each([
  "SIGINT",
  "SIGTERM",
] as const)("CLI %s reaps its owned compiler", async (signal) => {
  const pidPath = join(directory, "pid");
  const child = await startCli({
    json: true,
    compilerBody: `await Bun.write(${JSON.stringify(pidPath)}, String(process.pid)); await Bun.sleep(10000);`,
  });
  try {
    const deadline = Date.now() + 4000;
    while (!(await Bun.file(pidPath).exists()) && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    expect(await Bun.file(pidPath).exists()).toBe(true);
    const compilerPid = Number(await Bun.file(pidPath).text());
    child.kill(signal);
    const [stdout, exit] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    expect(exit).toBe(1);
    expect(JSON.parse(stdout).error.code).toBe("E_COMPILER_CANCELLED");
    expect(() => process.kill(compilerPid, 0)).toThrow();
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
});
