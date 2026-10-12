import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliUsageError } from "../src/cli/command.ts";
import { resolveRequestedEnvName } from "../src/cli/env-selection.ts";
import { optEnv } from "../src/cli/options.ts";
import { runCli } from "../src/cli/run.ts";
import { __testOnlySessionCommand } from "../src/commands/session.ts";
import { tryNativeComposeCommand } from "../src/lib/native-compose-command.ts";
import { restoreEnv } from "./helpers/env.ts";
import { requireTestConfigCompiler } from "./helpers/test-config-compiler.ts";

/**
 * One `--env` grammar across commands: `base`, `default` and `none` (any case)
 * select the base layers and bypass the configured default overlay, and an
 * unusable name is refused by every surface instead of silently selecting base.
 *
 * Compose-style projects back `env get`/`env list`; the authored native
 * project backs metadata-only `config plan` through the real compiler. Both
 * configure `qa` as the default overlay so omission and base differ.
 */

const realCompiler = requireTestConfigCompiler();
const BASE_SPELLINGS: string[] = ["base", "default", "DEFAULT", "none"];
const INVALID_NAME = "!!!";
const ENV_NAMES = [
  "HACK_GLOBAL_CONFIG_PATH",
  "HACK_CONFIG_COMPILER_BINARY",
  "HACK_ENV_SECRET_KEY",
  "HACK_SECRETS_FILE_KEY",
  "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK",
  "HACK_EXECUTION_MODE",
  "HACK_HOME",
  "HOME",
  "CI",
] as const;
const savedEnv = new Map<string, string | undefined>();
let root = "";
let composeRoot = "";
let nativeRoot = "";

beforeEach(async () => {
  // Native inputs must live in unredirected directories (no /var symlink).
  root = await realpath(
    await mkdtemp(join(tmpdir(), "hack-env-selection-parity-"))
  );
  composeRoot = join(root, "compose");
  nativeRoot = join(root, "native");
  for (const name of ENV_NAMES) {
    savedEnv.set(name, process.env[name]);
    Reflect.deleteProperty(process.env, name);
  }
  process.env.HOME = join(root, "home");
  process.env.HACK_HOME = join(root, "hack-home");
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  process.env.HACK_GLOBAL_CONFIG_PATH = join(root, "global.json");
  process.env.HACK_CONFIG_COMPILER_BINARY = realCompiler;
  await writeFile(process.env.HACK_GLOBAL_CONFIG_PATH, "{}");

  await mkdir(join(composeRoot, ".hack"), { recursive: true });
  await writeFile(
    join(composeRoot, ".hack/hack.config.json"),
    JSON.stringify({ name: "parity-compose", env: { defaultOverlay: "qa" } })
  );
  await writeFile(
    join(composeRoot, ".hack/docker-compose.yml"),
    "services:\n  api:\n    image: alpine:3.20\n"
  );
  await writeLayers(composeRoot);

  await mkdir(join(nativeRoot, ".hack"), { recursive: true });
  await writeFile(
    join(nativeRoot, ".hack/hack.project.json"),
    JSON.stringify({
      schema_version: 1,
      name: "parity-native",
      environment: { default_overlay: "qa" },
      worktree: { inherit_local: false, auto_branch: false },
      services: { web: { image: `sha256:${"a".repeat(64)}` } },
    })
  );
  await writeLayers(nativeRoot);
});

afterEach(async () => {
  for (const [name, value] of savedEnv) {
    restoreEnv(name, value);
  }
  savedEnv.clear();
  await rm(root, { recursive: true, force: true });
});

async function writeLayers(projectRoot: string): Promise<void> {
  for (const name of ["default", "qa"]) {
    await writeFile(
      join(projectRoot, `.hack/hack.env.${name}.yaml`),
      JSON.stringify({
        version: 1,
        environment: name,
        secretsprovider: "project_key",
        values: { global: { VALUE: name === "default" ? "base" : "qa" } },
      })
    );
  }
}

async function capture(args: readonly string[]) {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(Buffer.from(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(Buffer.from(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await runCli(args);
    return {
      code,
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
    };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

function envArgs(value: string | undefined): readonly string[] {
  return value === undefined ? [] : ["--env", value];
}

/** Selected overlay per surface; `null` is base layers only. */
async function selections(value: string | undefined) {
  const plan = await capture([
    "config",
    "plan",
    "--path",
    nativeRoot,
    ...envArgs(value),
    "--json",
  ]);
  const get = await capture([
    "env",
    "get",
    "VALUE",
    "--path",
    composeRoot,
    ...envArgs(value),
  ]);
  const list = await capture([
    "env",
    "list",
    "--path",
    composeRoot,
    ...envArgs(value),
    "--json",
  ]);
  return { plan, get, list };
}

function planOverlay(result: { readonly stdout: string }): unknown {
  const parsed: unknown = JSON.parse(result.stdout);
  expect(parsed).toHaveProperty("ok", true);
  expect(parsed).toHaveProperty("environment_plan.overlay");
  return (parsed as { environment_plan: { overlay: unknown } }).environment_plan
    .overlay;
}

function listOverlay(result: { readonly stdout: string }): unknown {
  const parsed: unknown = JSON.parse(result.stdout);
  expect(parsed).toHaveProperty("env_selection.effective");
  return (parsed as { env_selection: { effective: unknown } }).env_selection
    .effective;
}

test("omitting --env selects the configured default overlay on every surface", async () => {
  const { plan, get, list } = await selections(undefined);
  expect([plan.code, get.code, list.code]).toEqual([0, 0, 0]);
  expect(planOverlay(plan)).toBe("qa");
  expect(get.stdout).toBe("qa");
  expect(listOverlay(list)).toBe("qa");
});

test.each(
  BASE_SPELLINGS
)("--env %s selects base layers on config plan, env get and env list alike", async (spelling) => {
  const { plan, get, list } = await selections(spelling);
  expect([plan.code, get.code, list.code]).toEqual([0, 0, 0]);
  // Regression: config plan previously forwarded `default`/`DEFAULT`/`none`
  // as an overlay name, selecting `.hack/hack.env.default.yaml` as an overlay.
  expect(planOverlay(plan)).toBeNull();
  expect(get.stdout).toBe("base");
  expect(listOverlay(list)).toBeNull();
});

test("an unusable --env name is refused by every surface without reading values", async () => {
  const before = await readdir(join(nativeRoot, ".hack"));
  const { plan, get, list } = await selections(INVALID_NAME);
  for (const result of [plan, get, list]) {
    expect(result.code).not.toBe(0);
  }
  // JSON surfaces report the fixed usage envelope; `get` keeps stdout empty.
  for (const result of [plan, list]) {
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: { code: "E_USAGE", message: "Invalid --env value." },
    });
  }
  expect(get.stdout).toBe("");
  expect(get.stderr).toContain("Unable to read env value.");
  const validate = await capture([
    "config",
    "validate",
    "--path",
    nativeRoot,
    "--env",
    INVALID_NAME,
    "--json",
  ]);
  expect(validate.code).not.toBe(0);
  expect(JSON.parse(validate.stdout)).toHaveProperty("error.code", "E_USAGE");
  expect(await readdir(join(nativeRoot, ".hack"))).toEqual(before);
});

test("config validate shares the base spellings with config plan", async () => {
  for (const spelling of BASE_SPELLINGS) {
    const result = await capture([
      "config",
      "validate",
      "--path",
      nativeRoot,
      "--env",
      spelling,
      "--json",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveProperty(
      "local_resolution.overlay",
      null
    );
  }
});

test("authored native dispatch refuses an unusable --env before selecting a project", async () => {
  const error: unknown = await tryNativeComposeCommand({
    cwd: nativeRoot,
    path: nativeRoot,
    operation: "ps",
    overlay: INVALID_NAME,
  }).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(CliUsageError);
  expect(error).toHaveProperty("message", "Invalid --env value.");
});

test("the shared resolver maps base spellings to null and keeps workspace names env-base", () => {
  const { buildScopedWorkspaceBaseName } = __testOnlySessionCommand;
  expect(resolveRequestedEnvName({ envOption: undefined })).toBeUndefined();
  expect(resolveRequestedEnvName({ envOption: " QA " })).toBe("qa");
  expect(() => resolveRequestedEnvName({ envOption: INVALID_NAME })).toThrow(
    "Invalid --env value."
  );
  for (const spelling of BASE_SPELLINGS) {
    const envName = resolveRequestedEnvName({ envOption: spelling });
    expect(envName).toBeNull();
    expect(
      buildScopedWorkspaceBaseName({
        projectName: "parity",
        envOptionSpecified: true,
        envName,
        serviceName: null,
      })
    ).toBe("parity.env-base");
  }
  expect(optEnv.valueHint).toBe("<name|base|default>");
});
