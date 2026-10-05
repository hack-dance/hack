import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "../scripts/maintain-codex-slim.sh");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hack-slim-maintenance-"));
  const bin = join(root, "tools");
  const project = join(root, "project");
  const home = join(root, "home");
  const installed = join(root, "installed");
  await Promise.all([bin, project, home].map((path) => mkdir(path)));
  await writeFile(join(project, "index.ts"), "// test project\n");
  await writeFile(join(project, "bun.lock"), "preserve this lockfile\n");
  const fakeBun = join(bin, "bun");
  await writeFile(
    fakeBun,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$MAINTENANCE_TRACE"
if [ "$*" = "install --frozen-lockfile" ]; then
  exit "$MAINTENANCE_INSTALL_EXIT"
fi
printf 'unlocked install rewrote lockfile\\n' > bun.lock
`
  );
  await chmod(fakeBun, 0o755);
  return { root, bin, project, home, installed };
}

async function maintain({
  paths,
  installExit,
}: {
  readonly paths: Awaited<ReturnType<typeof fixture>>;
  readonly installExit: number;
}) {
  const child = Bun.spawn(["/bin/bash", script, paths.project], {
    env: {
      HOME: paths.home,
      PATH: `${paths.bin}:/usr/bin:/bin`,
      HACK_CODEX_BIN_DIR: paths.installed,
      HACK_ASSETS_DIR: join(paths.root, "assets"),
      MAINTENANCE_TRACE: join(paths.root, "trace"),
      MAINTENANCE_INSTALL_EXIT: String(installExit),
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("slim maintenance propagates a frozen install failure without rewriting the lock or installing", async () => {
  const paths = await fixture();
  try {
    const result = await maintain({ paths, installExit: 42 });
    expect(result.exitCode).toBe(42);
    expect(await readFile(join(paths.root, "trace"), "utf8")).toBe(
      "install --frozen-lockfile\n"
    );
    expect(await readFile(join(paths.project, "bun.lock"), "utf8")).toBe(
      "preserve this lockfile\n"
    );
    expect(await Bun.file(join(paths.installed, "hack")).exists()).toBe(false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("successful repeat maintenance preserves the lockfile and wrapper", async () => {
  const paths = await fixture();
  try {
    expect((await maintain({ paths, installExit: 0 })).exitCode).toBe(0);
    const wrapper = await readFile(join(paths.installed, "hack"), "utf8");
    expect((await maintain({ paths, installExit: 0 })).exitCode).toBe(0);
    expect(await readFile(join(paths.installed, "hack"), "utf8")).toBe(wrapper);
    expect(await readFile(join(paths.project, "bun.lock"), "utf8")).toBe(
      "preserve this lockfile\n"
    );
    expect(await readFile(join(paths.root, "trace"), "utf8")).toBe(
      "install --frozen-lockfile\ninstall --frozen-lockfile\n"
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
