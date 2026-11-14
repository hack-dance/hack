import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NATIVE_ENV_SECRET_SOURCE_REASON,
  nativeEnvSecretDenylist,
} from "../src/backends/native-env-source-denylist.ts";
import { prepareNativeProjectInput } from "../src/backends/native-project-input.ts";

/**
 * Hack key and secret-store files can never be native environment sources
 * (HACK-2062 follow-up). The refusal is closed and happens before any read.
 */

const KEY = "synthetic-key-material-canary";
const FILE = "synthetic-file-value-canary";
const roots: string[] = [];
const savedHackHome = process.env.HACK_HOME;

afterEach(async () => {
  if (savedHackHome === undefined) {
    Reflect.deleteProperty(process.env, "HACK_HOME");
  } else {
    process.env.HACK_HOME = savedHackHome;
  }
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(service: Record<string, unknown>) {
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-env-denylist-"))
  );
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { mode: 0o700 });
  const composeFile = join(projectDir, "docker-compose.yml");
  await writeFile(
    composeFile,
    JSON.stringify({ services: { app: { image: "alpine:3.21", ...service } } })
  );
  // Each fixture's Hack home is private and outside the project by default.
  process.env.HACK_HOME = join(
    projectRoot,
    "..",
    `${projectRoot.split("/").at(-1)}-home`
  );
  return { projectRoot, projectDir, composeFile };
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error: unknown) {
    return String(error);
  }
  throw new Error("expected a refusal");
}

test.each([
  ["../.hack.secret.key"],
  ["nested/.HACK.SECRET.KEY"],
  ["../.hack-secrets-file.key"],
  ["../.hack-secrets.enc.json"],
])("env_file %s is refused before it is read", async (path) => {
  const f = await fixture({ env_file: path });
  const target = join(f.projectDir, path);
  await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
  await writeFile(target, `TOKEN=${KEY}\n`, { mode: 0o600 });
  // Unreadable: any read attempt would refuse with a different reason.
  await chmod(target, 0o000);
  const message = await refusal(prepareNativeProjectInput(f));
  expect(message).toContain(NATIVE_ENV_SECRET_SOURCE_REASON);
  expect(message).not.toContain(KEY);
  expect(message).not.toContain(f.projectRoot);
});

test("an absent optional key-named source is refused, not skipped", async () => {
  const f = await fixture({
    env_file: { path: "../.hack.secret.key", required: false },
  });
  const message = await refusal(prepareNativeProjectInput(f));
  expect(message).toContain(NATIVE_ENV_SECRET_SOURCE_REASON);
});

test("fresh exec of one selected service refuses the same source", async () => {
  const f = await fixture({ env_file: "../.hack.secret.key" });
  await writeFile(join(f.projectRoot, ".hack.secret.key"), `${KEY}\n`, {
    mode: 0o600,
  });
  const message = await refusal(
    prepareNativeProjectInput({ ...f, selectedServices: ["app"] })
  );
  expect(message).toContain(NATIVE_ENV_SECRET_SOURCE_REASON);
  expect(message).not.toContain(KEY);
});

test("the automatic .env is refused when the Hack home is the project's .hack directory", async () => {
  const f = await fixture({ environment: { COPY: "${SOURCE}" } });
  process.env.HACK_HOME = f.projectDir;
  await writeFile(join(f.projectDir, ".env"), `SOURCE=${KEY}\n`, {
    mode: 0o600,
  });
  const message = await refusal(prepareNativeProjectInput(f));
  expect(message).toContain(NATIVE_ENV_SECRET_SOURCE_REASON);
  expect(message).not.toContain(KEY);
});

test("files under a Hack home inside the project root are refused; other sources still load", async () => {
  const f = await fixture({
    env_file: ["service.env", "../state/home/any.env"],
  });
  process.env.HACK_HOME = join(f.projectRoot, "state", "home");
  await writeFile(join(f.projectDir, "service.env"), `FILE=${FILE}\n`, {
    mode: 0o600,
  });
  const message = await refusal(prepareNativeProjectInput(f));
  expect(message).toContain(NATIVE_ENV_SECRET_SOURCE_REASON);
  expect(message).toContain("../state/home/any.env");

  const control = await fixture({ env_file: "service.env" });
  process.env.HACK_HOME = join(control.projectRoot, "state", "home");
  await writeFile(join(control.projectDir, "service.env"), `FILE=${FILE}\n`, {
    mode: 0o600,
  });
  const input = await prepareNativeProjectInput(control);
  expect(input.shellEnvironment).toEqual({ app: { FILE } });
});

test("a project inside the Hack home keeps ordinary sources and the name rules", async () => {
  const f = await fixture({ env_file: "service.env" });
  process.env.HACK_HOME = join(f.projectRoot, "..");
  await writeFile(join(f.projectDir, "service.env"), `FILE=${FILE}\n`, {
    mode: 0o600,
  });
  expect((await prepareNativeProjectInput(f)).shellEnvironment).toEqual({
    app: { FILE },
  });
  const named = await fixture({ env_file: "../.hack.secret.key" });
  process.env.HACK_HOME = join(named.projectRoot, "..");
  expect(await refusal(prepareNativeProjectInput(named))).toContain(
    NATIVE_ENV_SECRET_SOURCE_REASON
  );
});

test("the decision is lexical, case-folded and Unicode-normalized", () => {
  const denylist = nativeEnvSecretDenylist({
    projectRoots: ["/fixture/project"],
    hackHome: "/fixture/project/.Hack-Home",
  });
  expect(denylist.denies("/fixture/project/.hack.secret.key")).toBe(true);
  expect(denylist.denies("/fixture/project/deep/.Hack.Secret.Key")).toBe(true);
  expect(denylist.denies("/fixture/project/.hack-home/x.env")).toBe(true);
  expect(denylist.denies("/fixture/project/.hack-home")).toBe(true);
  expect(denylist.denies("/fixture/project/.hack/.env")).toBe(false);
  expect(denylist.denies("/fixture/project/.hack.secret.key.env")).toBe(false);
  // NFD and NFC spellings of the same Hack home name match.
  const unicode = nativeEnvSecretDenylist({
    projectRoots: ["/fixture/project"],
    hackHome: "/fixture/project/café",
  });
  expect(unicode.denies("/fixture/project/café/x.env")).toBe(true);
  // A Hack home outside the project root denies nothing by location.
  const outside = nativeEnvSecretDenylist({
    projectRoots: ["/fixture/project"],
    hackHome: "/fixture/home/.hack",
  });
  expect(outside.denies("/fixture/project/.hack/.env")).toBe(false);
});
