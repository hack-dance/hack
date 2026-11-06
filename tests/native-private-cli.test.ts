import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNativePrivateCli } from "../src/backends/native-private-cli.ts";

const roots: string[] = [];
const savedPath = process.env.PATH;
const savedProfile = process.env.AWS_PROFILE;
afterEach(async () => {
  process.env.PATH = savedPath;
  if (savedProfile === undefined) {
    Reflect.deleteProperty(process.env, "AWS_PROFILE");
  } else {
    process.env.AWS_PROFILE = savedProfile;
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
/** A scratch PATH directory holding one fake CLI; no real credential CLI is run. */
async function fakeCli(body: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-cli-")));
  roots.push(root);
  const path = join(root, "fake-credential-cli");
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  process.env.PATH = `${root}:/usr/bin:/bin`;
  return root;
}
class Refused extends Error {}
class Missing extends Error {}
const call = (environment: Record<string, string> = {}, timeoutMs?: number) =>
  runNativePrivateCli({
    executable: "fake-credential-cli",
    args: ["one", "two words"],
    environment,
    refused: () => new Refused("refused"),
    missing: () => new Missing("missing"),
    ...(timeoutMs ? { timeoutMs } : {}),
  });

test("captures stdout only with a clean environment and the caller's fixed keys", async () => {
  process.env.AWS_PROFILE = "ambient-should-not-leak";
  await fakeCli(
    'printf "%s|%s|" "$1" "$2"; env | sort | grep -v "^PWD=\\|^SHLVL=\\|^_=" | tr "\\n" ","; echo diagnostic >&2'
  );
  const output = await call({ FIXED: "1" });
  const text = output.toString();
  output.fill(0);
  expect(text.startsWith("one|two words|")).toBe(true);
  expect(text).toContain("FIXED=1");
  expect(text).toContain("PATH=");
  expect(text).not.toContain("AWS_PROFILE");
  expect(text).not.toContain("diagnostic");
});

test("nonzero exit, oversized output and a missing executable refuse distinctly", async () => {
  await fakeCli("echo partial; exit 3");
  await expect(call()).rejects.toBeInstanceOf(Refused);
  await fakeCli("head -c 70000 /dev/zero");
  await expect(call()).rejects.toBeInstanceOf(Refused);
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-cli-")));
  roots.push(root);
  process.env.PATH = root;
  await expect(call()).rejects.toBeInstanceOf(Missing);
});

test("timeout kills the request's whole process group and never retries", async () => {
  const root = await fakeCli(
    'sleep 30 & echo $! > "$(dirname "$0")/child"; echo started >> "$(dirname "$0")/runs"; wait'
  );
  const started = performance.now();
  await expect(call({}, 2000)).rejects.toBeInstanceOf(Refused);
  expect(performance.now() - started).toBeLessThan(10_000);
  const child = Number((await readFile(join(root, "child"), "utf8")).trim());
  let alive = true;
  for (let attempt = 0; attempt < 50 && alive; attempt += 1) {
    try {
      process.kill(child, 0);
      await Bun.sleep(20);
    } catch {
      alive = false;
    }
  }
  expect(alive).toBe(false);
  expect((await readFile(join(root, "runs"), "utf8")).trim()).toBe("started");
});
