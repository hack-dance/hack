import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVersionReport } from "../src/lib/version-report.ts";
import { machineData } from "./helpers/machine-output.ts";

const owned: string[] = [];
afterEach(async () => {
  for (const path of owned.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

test.each([
  ["5.0.0", "stable"],
  ["5.0.0-next.4", "next"],
  ["5.0.0-beta.1", "prerelease"],
] as const)("source identity for %s reports %s without inspecting another Hack", async (version, channel) => {
  expect(
    await buildVersionReport({
      version,
      executable: "/example/bun",
      compiled: false,
    })
  ).toEqual({
    version,
    channel,
    install_kind: "source",
    binary_path: "/example/bun",
  });
});

test("compiled identity inspects only the selected executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-version-"));
  owned.push(root);
  const binary = join(root, "hack");
  await writeFile(binary, "compiled placeholder");
  const report = (executable: string) =>
    buildVersionReport({ version: "5.0.0", executable, compiled: true });
  expect((await report(binary)).install_kind).toBe("standalone");
  const link = join(root, "linked-hack");
  await symlink(binary, link);
  expect((await report(link)).install_kind).toBe("symlink");
  expect((await report(join(root, "missing"))).install_kind).toBe("unknown");
});

test("source CLI JSON is pure, local and leaves a private home unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-version-cli-"));
  owned.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const cli = join(import.meta.dir, "..", "index.ts");
  const child = Bun.spawn([process.execPath, cli, "version", "--json"], {
    cwd: root,
    env: {
      HOME: home,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "transpiler-cache"),
      HACK_HOME: join(root, "hack-home"),
      TMPDIR: root,
      PATH: "",
      HACK_DAEMON_AUTOSTART_DISABLE: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).toBe(0);
  expect(stderr).toBe("");
  const report = machineData(stdout, "hack.version.v1");
  expect(Object.keys(report).sort()).toEqual([
    "binary_path",
    "channel",
    "install_kind",
    "schema",
    "version",
  ]);
  expect(report.install_kind).toBe("source");
  expect(report.binary_path).toBe(process.execPath);
  expect(report.version).toBeString();
  expect(await readdir(home)).toEqual([]);
});
