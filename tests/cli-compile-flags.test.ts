import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import cliPackage from "../packages/cli/package.json";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * Every shipped Bun executable is compiled with these flags. Without them a
 * compiled Bun program loads files from its working directory, which for
 * this CLI is a project the user may not trust: `bunfig.toml` preloads run
 * as the CLI, and `.env` fills in any variable the caller did not set (for
 * example `DOCKER_HOST` or a `HACK_*` setting).
 */
const NO_AUTOLOAD_FLAGS = [
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  "--no-compile-autoload-tsconfig",
  "--no-compile-autoload-package-json",
] as const;

/**
 * Files whose `bun build ... --compile` lines produce a shipped executable:
 * the candidate's `hack-cli` and `hack-mcp-backend`, and the runtime images'
 * `hack`. `scripts/build-macos-release.sh` (the retained, unsupported app) is
 * not held to this.
 */
const LINE_COMPILE_SITES = [
  "scripts/build-native-candidate.sh",
  "docker/slim-runtime/Dockerfile",
  "docker/node-runtime/Dockerfile",
] as const;

const COMPILE_LINE = /\bbun build \S+ --compile\b/;

const repository = resolve(import.meta.dir, "..");
let root = "";

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-compile-flags-")));
});

afterAll(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

test("every shipped Bun executable disables working-directory autoload", async () => {
  for (const flag of NO_AUTOLOAD_FLAGS) {
    expect(cliPackage.scripts.build).toContain(flag);
  }
  const release = await readFile(
    join(repository, "scripts/build-release.ts"),
    "utf8"
  );
  for (const flag of NO_AUTOLOAD_FLAGS) {
    expect(release).toContain(`"${flag}",`);
  }
  for (const site of LINE_COMPILE_SITES) {
    const lines = (await readFile(join(repository, site), "utf8"))
      .split("\n")
      .filter((line) => COMPILE_LINE.test(line));
    expect({ site, compiles: lines.length > 0 }).toEqual({
      site,
      compiles: true,
    });
    for (const line of lines) {
      for (const flag of NO_AUTOLOAD_FLAGS) {
        expect({ site, line, has: line.includes(flag) }).toEqual({
          site,
          line,
          has: true,
        });
      }
    }
  }
});

test("the flags stop a project's bunfig preload and .env from loading", async () => {
  const source = join(root, "source");
  const project = join(root, "project");
  await mkdir(source);
  await mkdir(project);
  await Bun.write(
    join(source, "probe.ts"),
    'process.stdout.write(`probe:${process.env.HACK_AUTOLOAD_PROBE ?? "unset"}\\n`);\n'
  );
  await Bun.write(join(project, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  await Bun.write(
    join(project, "preload.ts"),
    'process.stdout.write("preload ran\\n");\n'
  );
  await Bun.write(join(project, ".env"), "HACK_AUTOLOAD_PROBE=from-dotenv\n");

  const outputOf = async (flags: readonly string[]): Promise<string> => {
    const binary = join(root, flags.length > 0 ? "guarded" : "plain");
    const build = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "build",
        "probe.ts",
        "--compile",
        ...flags,
        "--outfile",
        binary,
      ],
      {
        cwd: source,
        env: privateCliEnv({ root }),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120_000,
      }
    );
    const [buildCode] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ]);
    expect(buildCode).toBe(0);
    const child = Bun.spawn([binary], {
      cwd: project,
      env: privateCliEnv({ root }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
    });
    const [code, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(0);
    return stdout;
  };

  // Control: without the flags the project's files do load, so the guarded
  // result below means the flags worked, not that the fixture is inert. If a
  // later Bun stops autoloading in compiled programs by default, this line
  // fails: the flags have then become no-ops, and the control needs updating,
  // not the guarded expectation.
  expect(await outputOf([])).toBe("preload ran\nprobe:from-dotenv\n");
  expect(await outputOf(NO_AUTOLOAD_FLAGS)).toBe("probe:unset\n");
}, 240_000);
