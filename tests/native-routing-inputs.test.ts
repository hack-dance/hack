import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireNativeGlobalDomain } from "../src/lib/native-routing-inputs.ts";
import { resolveVerifiedNativeBranch } from "../src/lib/worktree-local-config.ts";
import { restoreEnv } from "./helpers/env.ts";

const KEYS = [
  "PATH",
  "HACK_HOME",
  "HACK_GLOBAL_CONFIG_PATH",
  "CI",
  "HACK_EXECUTION_MODE",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
] as const;
const SENTINEL = "private-routing-sentinel";
let root: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) {
    if (key !== "PATH") {
      Reflect.deleteProperty(process.env, key);
    }
  }
  root = await realpath(
    await mkdtemp(join(tmpdir(), "native-routing-inputs-"))
  );
  process.env.HACK_HOME = join(root, "home");
});
afterEach(async () => {
  for (const key of KEYS) {
    restoreEnv(key, saved[key]);
  }
  await rm(root, { recursive: true, force: true });
});
async function failure(operation: Promise<unknown>, code = "E_CONFIG_INPUT") {
  const error: unknown = await operation.catch((value: unknown) => value);
  expect(error).toMatchObject({ code });
  expect(String(error)).not.toContain(SENTINEL);
  expect(String(error)).not.toContain(root);
  expect(error).not.toHaveProperty("cause");
}
async function policy(text: string | Uint8Array) {
  await mkdir(join(root, "home"), { recursive: true });
  const path = join(root, "home/hack.config.json");
  await writeFile(path, text);
  return path;
}
async function git(cwd: string, args: readonly string[]) {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await child.exited).toBe(0);
}
async function linked(branch = "feature/api") {
  const primary = join(root, "primary");
  await mkdir(primary);
  await git(primary, ["init", "--quiet", "-b", "main"]);
  await git(primary, [
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "--quiet",
    "-m",
    "fixture",
  ]);
  const checkout = join(root, "checkout");
  await git(primary, ["worktree", "add", "--quiet", "-b", branch, checkout]);
  return { primary, checkout };
}
const branch = (projectRoot: string, autoBranch = true) =>
  resolveVerifiedNativeBranch({ projectRoot, autoBranch });

test("global absence and unrelated policy return only an optional domain scalar", async () => {
  expect(await acquireNativeGlobalDomain()).toBeUndefined();
  await policy(JSON.stringify({ unrelated: { secret: SENTINEL } }));
  expect(await acquireNativeGlobalDomain()).toBeUndefined();
  await policy(
    JSON.stringify({
      default_domain: "EXAMPLE.invalid",
      unrelated: { secret: SENTINEL },
    })
  );
  expect(await acquireNativeGlobalDomain()).toBe("EXAMPLE.invalid");
  // Syntax and canonicalization belong to Rust, not the acquisition adapter.
  await policy(JSON.stringify({ default_domain: "not/a/domain" }));
  expect(await acquireNativeGlobalDomain()).toBe("not/a/domain");
});

test("explicit global path uses the same strict metadata-only read", async () => {
  const path = join(root, "custom.json");
  await writeFile(path, JSON.stringify({ default_domain: "custom.invalid" }));
  process.env.HACK_GLOBAL_CONFIG_PATH = path;
  expect(await acquireNativeGlobalDomain()).toBe("custom.invalid");
});

for (const kind of [
  "malformed",
  "array",
  "null",
  "wrong-type",
  "unreadable",
  "oversized",
  "directory",
  "symlink",
  "dangling",
  "utf8",
]) {
  test(`global ${kind} is a redacted failure rather than absent policy`, async () => {
    const path = await policy("{}");
    if (kind === "malformed") {
      await writeFile(path, `{"secret":${SENTINEL}`);
    }
    if (kind === "array") {
      await writeFile(path, "[]");
    }
    if (kind === "null") {
      await writeFile(path, "null");
    }
    if (kind === "wrong-type") {
      await writeFile(
        path,
        JSON.stringify({ default_domain: { secret: SENTINEL } })
      );
    }
    if (kind === "unreadable") {
      await chmod(path, 0);
    }
    if (kind === "oversized") {
      await writeFile(path, " ".repeat(1024 * 1024 + 1));
    }
    if (kind === "utf8") {
      await writeFile(path, new Uint8Array([0xff]));
    }
    if (["directory", "symlink", "dangling"].includes(kind)) {
      await rm(path);
      if (kind === "directory") {
        await mkdir(path);
      } else {
        const target = join(root, SENTINEL);
        if (kind === "symlink") {
          await writeFile(target, "{}");
        }
        await symlink(target, path);
      }
    }
    await failure(acquireNativeGlobalDomain());
  });
}

test("redirected global parent and cancellation refuse without values", async () => {
  await mkdir(join(root, "target"));
  await symlink(join(root, "target"), join(root, "home"));
  await failure(acquireNativeGlobalDomain());
  await failure(
    acquireNativeGlobalDomain({ signal: AbortSignal.abort(SENTINEL) }),
    "E_COMPILER_CANCELLED"
  );
});

test("namespace is linked-only and uses stable sanitization while ignoring caller Git redirection", async () => {
  const { primary, checkout } = await linked();
  expect(await branch(primary)).toBeUndefined();
  expect(await branch(root)).toBeUndefined();
  expect(await branch(checkout)).toBe("feature-api");
  process.env.GIT_DIR = join(root, SENTINEL);
  process.env.GIT_WORK_TREE = join(root, SENTINEL);
  process.env.GIT_COMMON_DIR = join(root, SENTINEL);
  expect(await branch(checkout)).toBe("feature-api");
  await mkdir(join(checkout, "nested"));
  expect(await branch(join(checkout, "nested"))).toBeUndefined();
});

test("colliding worktree branches follow the existing raw-name hash suffix convention", async () => {
  const { primary, checkout } = await linked();
  const other = join(root, "other");
  await git(primary, [
    "worktree",
    "add",
    "--quiet",
    "-b",
    "feature-api",
    other,
  ]);
  const hash = (name: string) =>
    new Bun.CryptoHasher("sha1").update(name).digest("hex").slice(0, 4);
  expect(await branch(checkout)).toBe(`feature-api-${hash("feature/api")}`);
  expect(await branch(other)).toBe(`feature-api-${hash("feature-api")}`);
});

test("auto_branch optout and runner exclusions avoid unsafe linkage inspection", async () => {
  const { checkout } = await linked();
  await writeFile(join(checkout, ".git"), `gitdir: ${SENTINEL}`);
  expect(await branch(checkout, false)).toBeUndefined();
  process.env.CI = "true";
  expect(await branch(checkout)).toBeUndefined();
  Reflect.deleteProperty(process.env, "CI");
  process.env.HACK_EXECUTION_MODE = "slim";
  expect(await branch(checkout)).toBeUndefined();
});

test("linked detached, oversized branch and redirected root refuse rather than share base", async () => {
  const { checkout } = await linked();
  await git(checkout, ["checkout", "--quiet", "--detach"]);
  await failure(branch(checkout), "E_CONFIG_INVALID");
  await git(checkout, ["checkout", "--quiet", "-b", "a".repeat(64)]);
  await failure(branch(checkout), "E_CONFIG_INVALID");
  const redirect = join(root, "redirect");
  await symlink(checkout, redirect);
  await failure(branch(redirect), "E_CONFIG_INVALID");
  await failure(
    resolveVerifiedNativeBranch({
      projectRoot: checkout,
      autoBranch: true,
      signal: AbortSignal.abort(SENTINEL),
    }),
    "E_COMPILER_CANCELLED"
  );
});

test("branch generation changing during repeated inspection refuses instead of returning a stale namespace", async () => {
  const { checkout } = await linked();
  const actualGit = Bun.which("git");
  if (!actualGit) {
    throw new Error("Git fixture executable missing");
  }
  const bin = join(root, "bin");
  const count = join(root, "inspections");
  await mkdir(bin);
  const wrapper = join(bin, "git");
  await writeFile(
    wrapper,
    `#!${process.execPath}
const args=process.argv.slice(2);
if(args.includes('symbolic-ref')) {
 const path=${JSON.stringify(count)};
 const prior=await Bun.file(path).exists()?Number(await Bun.file(path).text()):0;
 await Bun.write(path,String(prior+1));
 if(prior===1) { const change=Bun.spawn([${JSON.stringify(actualGit)},'-C',${JSON.stringify(checkout)},'branch','-m','changed-branch'],{stdout:'ignore',stderr:'ignore'}); if(await change.exited!==0) process.exit(2); }
}
const child=Bun.spawn([${JSON.stringify(actualGit)},...args],{stdin:'ignore',stdout:'inherit',stderr:'ignore'});process.exit(await child.exited);
`
  );
  await chmod(wrapper, 0o700);
  process.env.PATH = bin;
  await failure(branch(checkout), "E_CONFIG_INVALID");
  expect(await Bun.file(count).text()).toBe("2");
});
