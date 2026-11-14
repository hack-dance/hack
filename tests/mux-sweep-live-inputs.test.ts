import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLiveInputScope } from "../src/lib/live-inputs.ts";
import { findProjectContext } from "../src/lib/project.ts";
import {
  MUX_ENVIRONMENT_TTL_MS,
  sweepStaleMuxEnvironments,
} from "../src/mux/private-environment.ts";
import { restoreEnv } from "./helpers/env.ts";

// ---------------------------------------------------------------------------
// HACK-2181: the automatic sweep before a new terminal-session staging never
// removes a file current configuration reads, even inside a directory that
// looks exactly like a stale payload. Real files and a real configuration.
// ---------------------------------------------------------------------------

let root = "";
let saved: { config?: string; home?: string } = {};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-sweep-live-")));
  saved = {
    config: process.env.HACK_GLOBAL_CONFIG_PATH,
    home: process.env.HACK_HOME,
  };
  process.env.HACK_HOME = join(root, "hack-home");
  process.env.HACK_GLOBAL_CONFIG_PATH = join(root, "hack.config.json");
});

afterEach(async () => {
  restoreEnv("HACK_GLOBAL_CONFIG_PATH", saved.config);
  restoreEnv("HACK_HOME", saved.home);
  await rm(root, { recursive: true, force: true });
});

/** A private directory that looks like a payload left by a session that never ran. */
async function stalePayload(parent: string, name: string): Promise<string> {
  const dir = join(parent, `hack-mux-env-${name}`);
  await mkdir(dir, { mode: 0o700 });
  await writeFile(join(dir, "env.json"), "{}", { mode: 0o600 });
  const old = new Date(Date.now() - MUX_ENVIRONMENT_TTL_MS - 60_000);
  await utimes(join(dir, "env.json"), old, old);
  await utimes(dir, old, old);
  return dir;
}

const scopeFrom = (startDir: string) => () =>
  resolveLiveInputScope({
    startDir,
    strict: true,
    findProject: findProjectContext,
  });

test("a configured store key inside a payload-like directory is never removed; an ordinary stale payload is", async () => {
  const parent = join(root, "tmp");
  await mkdir(parent);
  const holdsKey = await stalePayload(parent, "configured");
  const ordinary = await stalePayload(parent, "ordinary");
  // The global configuration names that directory's env.json as the key of
  // the encrypted-file store.
  await writeFile(
    join(root, "hack.config.json"),
    JSON.stringify({
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: {
            path: join(root, "store.json"),
            keyPath: join(holdsKey, "env.json"),
          },
        },
      },
    })
  );
  await sweepStaleMuxEnvironments({ parent, scope: scopeFrom(root) });
  expect(await readFile(join(holdsKey, "env.json"), "utf8")).toBe("{}");
  expect(await lstat(ordinary).catch(() => null)).toBeNull();
});

test("when the configuration cannot be read, the automatic sweep removes nothing", async () => {
  const parent = join(root, "tmp");
  await mkdir(parent);
  const stale = await stalePayload(parent, "kept");
  await writeFile(join(root, "hack.config.json"), "{ not json");
  await sweepStaleMuxEnvironments({ parent, scope: scopeFrom(root) });
  expect((await lstat(join(stale, "env.json"))).isFile()).toBe(true);
  // Same when resolving throws for any other reason.
  await sweepStaleMuxEnvironments({
    parent,
    scope: async () => {
      throw new Error("unreadable");
    },
  });
  expect((await lstat(join(stale, "env.json"))).isFile()).toBe(true);
});

test("the global configuration itself is a live input when stored in a stale payload", async () => {
  const parent = join(root, "tmp");
  await mkdir(parent);
  const configured = await stalePayload(parent, "global-config");
  const ordinary = await stalePayload(parent, "ordinary");
  process.env.HACK_GLOBAL_CONFIG_PATH = join(configured, "env.json");
  await sweepStaleMuxEnvironments({ parent, scope: scopeFrom(root) });
  expect(await readFile(join(configured, "env.json"), "utf8")).toBe("{}");
  expect(await lstat(ordinary).catch(() => null)).toBeNull();
});

/** A project whose own configuration may name a store key; cwd moves into it. */
async function inProject<T>(config: string, run: () => Promise<T>): Promise<T> {
  const project = join(root, "project");
  await mkdir(join(project, ".hack"), { recursive: true });
  await writeFile(
    join(project, ".hack", "docker-compose.yml"),
    "services: {}\n"
  );
  await writeFile(join(project, ".hack", "hack.config.json"), config);
  const cwd = process.cwd();
  process.chdir(project);
  try {
    return await run();
  } finally {
    process.chdir(cwd);
  }
}

test("by default the sweep resolves the configuration from the current directory", async () => {
  const parent = join(root, "tmp");
  await mkdir(parent);
  const holdsKey = await stalePayload(parent, "configured");
  const ordinary = await stalePayload(parent, "ordinary");
  // Only the project's own configuration (found from the current directory)
  // names the key: no injected scope, no global setting.
  await inProject(
    JSON.stringify({
      name: "sweepdefault",
      controlPlane: {
        secrets: {
          backend: "encrypted_file",
          encryptedFile: {
            path: join(root, "store.json"),
            keyPath: join(holdsKey, "env.json"),
          },
        },
      },
    }),
    () => sweepStaleMuxEnvironments({ parent })
  );
  expect(await readFile(join(holdsKey, "env.json"), "utf8")).toBe("{}");
  expect(await lstat(ordinary).catch(() => null)).toBeNull();
});

test("by default an unparsable project configuration removes nothing", async () => {
  const parent = join(root, "tmp");
  await mkdir(parent);
  const stale = await stalePayload(parent, "kept");
  await inProject("{ not json", () => sweepStaleMuxEnvironments({ parent }));
  expect((await lstat(join(stale, "env.json"))).isFile()).toBe(true);
});
