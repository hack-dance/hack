import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const runner = resolve(
  import.meta.dir,
  "../../scripts/portable-bootstrap-smoke.ts"
);
export const entrypoint = resolve(import.meta.dir, "../../index.ts");

/** Only the wrapper selects source; the portable runner itself imports no repo modules. */
export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function run(input: { root: string; binary: string }) {
  const child = Bun.spawn(
    [process.execPath, runner, "--hack-bin", input.binary],
    {
      cwd: input.root,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: join(input.root, "home"),
        TMPDIR: join(input.root, "tmp"),
        HACK_HOME: join(input.root, "foreign"),
        HACK_GLOBAL_CONFIG_PATH: join(
          input.root,
          "foreign",
          "must-not-read.json"
        ),
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_BINARY: "/invalid/unrelated-executor",
        HACK_NATIVE_HOME: join(input.root, "foreign", "native-home"),
        HACK_ENV_SECRET_KEY: "parent-secret-must-not-reach-child",
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        NO_COLOR: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => child.kill("SIGTERM"), 45_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export function portableBootstrapHarness() {
  const roots: string[] = [];
  async function fixture(script: string) {
    const root = await mkdtemp(join(tmpdir(), "hack-portable-runner-test-"));
    roots.push(root);
    for (const name of ["home", "tmp", "foreign"]) {
      await mkdir(join(root, name));
    }
    const binary = join(root, "selected-hack");
    await writeFile(binary, `#!/bin/sh\n${script}\n`);
    await chmod(binary, 0o700);
    return { root, binary };
  }

  async function cleanup() {
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  }
  return { fixture, run, cleanup };
}
