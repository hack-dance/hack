import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inspectLegacyComposeAdoptionSelection } from "../src/lib/native-compose-adoption-marker.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";
import {
  retainedSourceBindFixture,
  SOURCE_BIND_CANARY,
} from "./helpers/retained-source-bind-adoption.ts";

/**
 * HACK-1380: in an adopted (`hack config adopt`) project, `hack doctor --fix`
 * only untracks tracked generated files and leaves the adoption's
 * `.hack/.gitignore` unchanged. The `generated files` warning must say so
 * instead of promising to ensure the committed `.hack/.gitignore`. The
 * fixture is the synthetic retained source-bind adoption (no real engine);
 * Git runs only against the fixture checkout with no global or system config.
 */
let h: Awaited<ReturnType<typeof retainedSourceBindFixture>>;
beforeEach(async () => {
  h = await retainedSourceBindFixture();
});
afterEach(async () => {
  await h.cleanup();
});

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
} as const;

function git(args: readonly string[]): void {
  const result = Bun.spawnSync(["/usr/bin/git", ...args], {
    cwd: h.root,
    env: { PATH: "/usr/bin:/bin", HOME: h.outer, ...GIT_ENV },
    stdout: "ignore",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed in the fixture checkout.`);
  }
}

/** Read-only `doctor --json` in a private HOME and HACK_HOME, stub engine only. */
async function doctorJson(): Promise<string> {
  const state = join(h.outer, "state");
  await mkdir(state, { recursive: true });
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "..", "index.ts"),
      "doctor",
      "--path",
      h.root,
      "--json",
    ],
    {
      cwd: h.root,
      env: privateCliEnv({
        root: h.outer,
        env: {
          HACK_HOME: state,
          HACK_GLOBAL_CONFIG_PATH: join(state, "hack.config.json"),
          HACK_DAEMON_DISABLE: "1",
          HACK_NO_INTERACTIVE: "1",
          HACK_LOGGER: "console",
          HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
          XDG_CACHE_HOME: join(h.outer, "cache"),
          PATH: `${h.outer}:/usr/bin:/bin`,
          ...GIT_ENV,
        },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return stdout;
}

test("doctor's generated files warning for an adopted project says --fix leaves .hack/.gitignore unchanged", async () => {
  // A real Git checkout with a committed generated file.
  await rm(join(h.root, ".git"), { recursive: true });
  git(["init", "-q"]);
  await writeFile(join(h.root, ".hack/.env.state.json"), "{}\n", {
    mode: 0o600,
  });
  git(["add", "-f", ".hack/.env.state.json"]);
  const store = await h.store();
  try {
    const generation = await store.prepare({ binary: h.compiler });
    await store.publish({ generation, binary: h.compiler });
  } finally {
    await store.close();
  }
  expect(
    await inspectLegacyComposeAdoptionSelection({ projectRoot: h.root })
  ).toBe("active");

  const stdout = await doctorJson();
  expect(stdout).not.toContain(SOURCE_BIND_CANARY);
  const parsed: unknown = JSON.parse(stdout);
  const checks = (
    parsed as {
      data: { checks: { id: string; status: string; detail: string }[] };
    }
  ).data.checks;
  expect(checks.find((check) => check.id === "generated files")).toMatchObject({
    status: "warn",
    detail:
      "Machine-local generated files are tracked in git: .hack/.env.state.json. Run 'hack doctor --fix' to untrack them (files stay on disk). It leaves the adopted project's .hack/.gitignore unchanged, so keep these files out of later commits.",
  });
  expect(stdout).not.toContain("ensure the committed");
}, 120_000);
