import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { withCaseExecutables } from "./helpers/case-executables.ts";

const PRELOAD = resolve(
  import.meta.dir,
  "helpers/global-state-guard-preload.ts"
);
const HELPER = resolve(import.meta.dir, "helpers/case-executables.ts");
const PROBE = resolve(
  import.meta.dir,
  "../src/lib/native-compose-ownership.ts"
);
const owned: string[] = [];
/** Deadline for one nested run; each outer case allows 60 s. */
const CHILD_DEADLINE_MS = 50_000;

afterEach(async () => {
  await Promise.all(
    owned.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function tempDir(): Promise<string> {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "hack-case-executables-"))
  );
  owned.push(dir);
  return dir;
}

/**
 * A case that puts a stub `docker` first on PATH, times out, and keeps
 * running. Once the guard has put the outer PATH back, the late body makes a
 * new native Compose probe, which resolves `docker` again. The outer PATH
 * holds only a fake "host" `docker`, so no real Docker client or socket is
 * reachable either way. A second case keeps the run alive until the late body
 * has written what it reached.
 */
function lateBodySuite(pinned: boolean): string {
  return `import { expect, test } from "bun:test";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createNativeComposeProbe } from ${JSON.stringify(PROBE)};
import { withCaseExecutables } from ${JSON.stringify(HELPER)};
const stub = process.env.HACK_LATE_BODY_STUB;
const out = process.env.HACK_LATE_BODY_OUT;
test("times out while its engine calls continue", async () => {
  const saved = process.env.PATH;
  process.env.PATH = stub;
  const late = async () => {
    const deadline = Date.now() + 20_000;
    while (process.env.PATH === stub && Date.now() < deadline) await Bun.sleep(10);
    const restored = process.env.PATH !== stub;
    let reached;
    try {
      reached = (await createNativeComposeProbe({ timeoutMs: 10_000 })(["info"])).trim();
    } catch (error) {
      reached = "refused: " + String(error?.code ?? error);
    }
    writeFileSync(out, JSON.stringify({ restored, reached }));
  };
  try {
    ${pinned ? 'await withCaseExecutables({ docker: join(stub, "docker") }, late);' : "await late();"}
  } finally {
    process.env.PATH = saved;
  }
}, 200);
test("waits for the late body", async () => {
  const deadline = Date.now() + 25_000;
  while (!existsSync(out) && Date.now() < deadline) await Bun.sleep(20);
  expect(existsSync(out)).toBe(true);
}, 30_000);
`;
}

async function runLateBody(pinned: boolean): Promise<{
  readonly output: string;
  readonly late: { readonly restored: boolean; readonly reached: string };
}> {
  const dir = await tempDir();
  const host = join(dir, "host-bin");
  const stub = join(dir, "stub-bin");
  const suite = join(dir, "suite");
  const out = join(dir, "late.json");
  for (const path of [host, stub, suite]) {
    await mkdir(path);
  }
  await writeFile(join(host, "docker"), "#!/bin/sh\necho host-docker\n");
  await writeFile(join(stub, "docker"), "#!/bin/sh\necho stub-docker\n");
  await chmod(join(host, "docker"), 0o755);
  await chmod(join(stub, "docker"), 0o755);
  await writeFile(
    join(suite, "bunfig.toml"),
    `[test]\npreload = [${JSON.stringify(PRELOAD)}]\n`
  );
  await writeFile(join(suite, "late-body.test.ts"), lateBodySuite(pinned));
  const child = Bun.spawn([process.execPath, "test", "./late-body.test.ts"], {
    cwd: suite,
    env: {
      PATH: host,
      HOME: dir,
      TMPDIR: dir,
      NO_COLOR: "1",
      // A socket that does not exist, so even a real client could reach no engine.
      DOCKER_HOST: `unix://${join(dir, "absent.sock")}`,
      HACK_LATE_BODY_STUB: stub,
      HACK_LATE_BODY_OUT: out,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  // The child is killed at its deadline and always reaped here, before
  // afterEach removes the directory it runs in.
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, CHILD_DEADLINE_MS);
  let stdout: string;
  let stderr: string;
  try {
    [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
  if (timedOut) {
    throw new Error(
      `nested bun test exceeded ${CHILD_DEADLINE_MS} ms and was killed:\n${stdout}\n${stderr}`
    );
  }
  const output = `${stdout}\n${stderr}`;
  const text = await readFile(out, "utf8").catch(() => {
    throw new Error(`late body wrote nothing:\n${output}`);
  });
  return { output, late: JSON.parse(text) };
}

test("without a pin, a late body's probe reaches the outer PATH's docker after the guard restores PATH", async () => {
  const run = await runLateBody(false);
  expect(run.output).toContain("this test timed out after 200ms");
  expect(run.output).toContain(
    "[global-state-guard] a test in late-body.test.ts left process state changed: env PATH changed."
  );
  expect(run.late).toEqual({ restored: true, reached: "host-docker" });
}, 60_000);

test("a pinned late body reaches only its stub after the guard restores PATH", async () => {
  const run = await runLateBody(true);
  expect(run.output).toContain("this test timed out after 200ms");
  expect(run.output).toContain(
    "[global-state-guard] a test in late-body.test.ts left process state changed: env PATH changed."
  );
  expect(run.late).toEqual({ restored: true, reached: "stub-docker" });
  expect(run.output).not.toContain("host-docker");
  // The preload installed the wrapper before its baseline, so the guard
  // never reports it as a replaced function.
  expect(run.output).not.toContain("Bun.which replaced");
}, 60_000);

test("pins answer only inside their case context and refuse paths that are not absolute", async () => {
  const outside = Bun.which("hack-case-executables-pin");
  expect(outside).toBeNull();
  const inside = await withCaseExecutables(
    { "hack-case-executables-pin": "/pinned/stub" },
    async () => {
      await Bun.sleep(1);
      return Bun.which("hack-case-executables-pin", { PATH: "" });
    }
  );
  expect(inside).toBe("/pinned/stub");
  expect(Bun.which("hack-case-executables-pin")).toBeNull();
  expect(() => withCaseExecutables({ docker: "stub/docker" }, () => 0)).toThrow(
    "absolute paths"
  );
  expect(() => withCaseExecutables({ "bin/docker": "/stub" }, () => 0)).toThrow(
    "bare executable names"
  );
});

test("a nested scope keeps the outer pins and overrides only its own names", async () => {
  const seen = await withCaseExecutables(
    { docker: "/outer/docker", git: "/outer/git" },
    () =>
      withCaseExecutables(
        { git: "/inner/git", tar: "/inner/tar" },
        async () => {
          await Bun.sleep(1);
          return [
            Bun.which("docker", { PATH: "" }),
            Bun.which("git", { PATH: "" }),
            Bun.which("tar", { PATH: "" }),
          ];
        }
      )
  );
  expect(seen).toEqual(["/outer/docker", "/inner/git", "/inner/tar"]);
});

test("String and byte names match a pin, and other names are refused inside a pinned scope", () => {
  const stub = "/pinned/docker";
  withCaseExecutables({ docker: stub }, () => {
    // Bun 1.4.4 resolves these forms on PATH, so each must hit the pin.
    // biome-ignore lint/style/useConsistentBuiltinInstantiation: the String object form is the case under test.
    expect(Bun.which(new String("docker") as unknown as string)).toBe(stub);
    expect(Bun.which(Buffer.from("docker") as unknown as string)).toBe(stub);
    expect(
      Bun.which(new TextEncoder().encode("docker") as unknown as string)
    ).toBe(stub);
    expect(() => Bun.which(42 as unknown as string)).toThrow(
      "needs a string, String or byte name"
    );
  });
  // Outside a pinned scope the real lookup answers, refusing nothing.
  expect(Bun.which(42 as unknown as string)).toBeNull();
});
