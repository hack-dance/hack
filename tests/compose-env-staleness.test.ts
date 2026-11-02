import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRequestedEnvName } from "../src/cli/env-selection.ts";
import { resolveModernComposeEnvOverrides } from "../src/commands/project.ts";
import {
  buildStaleComposeEnvWarning,
  COMPOSE_ENV_FINGERPRINT_VERSION,
  computeComposeEnvFingerprint,
  evaluateComposeServiceEnvFreshness,
  parseComposeEnvFingerprintRecord,
  withComposeServiceEnvFingerprints,
  withoutComposeServiceEnvFingerprints,
} from "../src/lib/compose-env-fingerprint.ts";
import { findProjectContextAtRoot } from "../src/lib/project.ts";
import {
  readProjectRuntimeStateEntry,
  resolveComposeExecStaleEnvWarning,
  resolveProjectRuntimeStatePath,
  updateProjectRuntimeServiceEnvFingerprints,
  upsertProjectRuntimeStateEntry,
} from "../src/lib/project-runtime-state.ts";
import { restoreEnv } from "./helpers/env.ts";

/**
 * HACK-1140: `hack exec` warns, without printing any key or value, when the
 * env resolved now differs from the env a running compose service was created
 * with. All state lives in a temp project; no Docker, HOME, or client config
 * is touched.
 */

const SALT = "0123456789abcdef0123456789abcdef";
const OTHER_SALT = "fedcba9876543210fedcba9876543210";
const SECRET_ONE = "synthetic-stale-env-value-one";
const SECRET_TWO = "synthetic-stale-env-value-two";
const KEY = "SYNTHETIC_STALE_KEY";
const COMPOSE_PROJECT = "stale-fixture";
const ENV_NAMES = [
  "CI",
  "HACK_ENV_SECRET_KEY",
  "HACK_EXECUTION_MODE",
  "HACK_GLOBAL_CONFIG_PATH",
  "HACK_HOME",
  "HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK",
  "HOME",
] as const;

const savedEnv = new Map<string, string | undefined>();
let root = "";
let projectDir = "";

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-stale-env-")));
  projectDir = join(root, "project", ".hack");
  for (const name of ENV_NAMES) {
    savedEnv.set(name, process.env[name]);
    Reflect.deleteProperty(process.env, name);
  }
  process.env.HOME = join(root, "home");
  process.env.HACK_HOME = join(root, "hack-home");
  process.env.HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK = "1";
  process.env.HACK_GLOBAL_CONFIG_PATH = join(root, "global.json");
  await writeFile(process.env.HACK_GLOBAL_CONFIG_PATH, "{}");
  await mkdir(projectDir, { recursive: true });
});

afterEach(async () => {
  for (const [name, value] of savedEnv) {
    restoreEnv(name, value);
  }
  savedEnv.clear();
  await rm(root, { recursive: true, force: true });
});

describe("compose env fingerprint", () => {
  test("is order-independent and changes with any key, value, or salt", () => {
    const base = computeComposeEnvFingerprint({
      salt: SALT,
      env: { A: "1", B: "2" },
    });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(
      computeComposeEnvFingerprint({ salt: SALT, env: { B: "2", A: "1" } })
    ).toBe(base);
    const variants: readonly Readonly<Record<string, string>>[] = [
      { A: "1", B: "3" },
      { A: "1" },
      { A: "1", B: "2", C: "" },
      { A: "1", C: "2" },
    ];
    for (const env of variants) {
      expect(computeComposeEnvFingerprint({ salt: SALT, env })).not.toBe(base);
    }
    expect(
      computeComposeEnvFingerprint({
        salt: OTHER_SALT,
        env: { A: "1", B: "2" },
      })
    ).not.toBe(base);
    expect(() =>
      computeComposeEnvFingerprint({ salt: "not-hex", env: {} })
    ).toThrow("Invalid compose env fingerprint salt.");
  });

  test("records hold no key or value and round-trip through the strict parser", () => {
    const record = withComposeServiceEnvFingerprints({
      existing: undefined,
      services: ["web", "api", "bad name"],
      envByService: { web: { [KEY]: SECRET_ONE } },
      createSalt: () => SALT,
    });
    expect(record.version).toBe(COMPOSE_ENV_FINGERPRINT_VERSION);
    expect(Object.keys(record.services)).toEqual(["api", "web"]);
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain(SECRET_ONE);
    expect(parseComposeEnvFingerprintRecord(JSON.parse(serialized))).toEqual(
      record
    );
    for (const malformed of [
      null,
      { ...record, version: 2 },
      { ...record, salt: "short" },
      { ...record, services: { web: "not-a-digest" } },
      { ...record, services: { "bad name": "0".repeat(64) } },
    ]) {
      expect(parseComposeEnvFingerprintRecord(malformed)).toBeUndefined();
    }
  });

  test("freshness: identical env is unchanged, a changed value is changed, absence is unknown", () => {
    const record = withComposeServiceEnvFingerprints({
      existing: undefined,
      services: ["web"],
      envByService: { web: { [KEY]: SECRET_ONE } },
      createSalt: () => SALT,
    });
    expect(
      evaluateComposeServiceEnvFreshness({
        record,
        service: "web",
        currentEnv: { [KEY]: SECRET_ONE },
      })
    ).toBe("unchanged");
    expect(
      evaluateComposeServiceEnvFreshness({
        record,
        service: "web",
        currentEnv: { [KEY]: SECRET_TWO },
      })
    ).toBe("changed");
    expect(
      evaluateComposeServiceEnvFreshness({
        record,
        service: "api",
        currentEnv: {},
      })
    ).toBe("unknown");
    expect(
      evaluateComposeServiceEnvFreshness({
        record: undefined,
        service: "web",
        currentEnv: {},
      })
    ).toBe("unknown");
    expect(
      evaluateComposeServiceEnvFreshness({
        record: withoutComposeServiceEnvFingerprints({
          existing: record,
          services: ["web"],
        }),
        service: "web",
        currentEnv: { [KEY]: SECRET_TWO },
      })
    ).toBe("unknown");
  });

  test("the warning is closed: it names a valid service and never echoes other input", () => {
    expect(buildStaleComposeEnvWarning({ service: "web" })).toBe(
      'Env for service "web" changed since it started; this exec uses the env it started with. Run `hack restart web` to apply the current env.'
    );
    const hostile = buildStaleComposeEnvWarning({
      service: `web; echo ${SECRET_ONE}`,
    });
    expect(hostile).not.toContain(SECRET_ONE);
    expect(hostile).toContain("this service");
    expect(hostile).toContain("`hack restart <service>`");
  });
});

describe("runtime state staleness", () => {
  async function recordUp(env: Readonly<Record<string, string>>) {
    await upsertProjectRuntimeStateEntry({
      projectDir,
      entry: {
        composeProject: COMPOSE_PROJECT,
        envName: null,
        updatedAt: "2026-10-12T00:00:00.000Z",
        envFingerprint: withComposeServiceEnvFingerprints({
          existing: undefined,
          services: ["web", "api"],
          envByService: { web: env, api: env },
        }),
      },
    });
  }

  function warningFor(service: string, env: Readonly<Record<string, string>>) {
    return resolveComposeExecStaleEnvWarning({
      projectDir,
      composeProject: COMPOSE_PROJECT,
      service,
      currentEnv: env,
    });
  }

  test("negative control: identical env produces no warning", async () => {
    await recordUp({ [KEY]: SECRET_ONE });
    expect(await warningFor("web", { [KEY]: SECRET_ONE })).toBeNull();
    const stored = await readFile(
      resolveProjectRuntimeStatePath({ projectDir }),
      "utf8"
    );
    expect(stored).not.toContain(KEY);
    expect(stored).not.toContain(SECRET_ONE);
  });

  test("changed env warns with the service name and no value", async () => {
    await recordUp({ [KEY]: SECRET_ONE });
    const warning = await warningFor("web", { [KEY]: SECRET_TWO });
    expect(warning).toBe(buildStaleComposeEnvWarning({ service: "web" }));
    expect(warning).toContain("`hack restart web`");
    for (const text of [KEY, SECRET_ONE, SECRET_TWO]) {
      expect(warning).not.toContain(text);
    }
  });

  test("state without fingerprints (pre-upgrade) or a missing entry never warns", async () => {
    expect(await warningFor("web", { [KEY]: SECRET_TWO })).toBeNull();
    await upsertProjectRuntimeStateEntry({
      projectDir,
      entry: {
        composeProject: COMPOSE_PROJECT,
        envName: null,
        updatedAt: "2026-10-12T00:00:00.000Z",
      },
    });
    expect(await warningFor("web", { [KEY]: SECRET_TWO })).toBeNull();
    const path = resolveProjectRuntimeStatePath({ projectDir });
    const tampered = JSON.parse(await readFile(path, "utf8")) as {
      entries: Record<string, unknown>[];
    };
    tampered.entries[0] = {
      ...tampered.entries[0],
      envFingerprint: { version: 1, salt: SALT, services: { web: "x" } },
    };
    await writeFile(path, JSON.stringify(tampered));
    expect(await warningFor("web", { [KEY]: SECRET_TWO })).toBeNull();
    expect(
      (
        await readProjectRuntimeStateEntry({
          projectDir,
          composeProject: COMPOSE_PROJECT,
        })
      )?.envName
    ).toBeNull();
  });

  test("a scoped restart refreshes only its services; other services stay stale", async () => {
    await recordUp({ [KEY]: SECRET_ONE });
    await updateProjectRuntimeServiceEnvFingerprints({
      projectDir,
      composeProject: COMPOSE_PROJECT,
      effectiveEnvName: null,
      services: ["web"],
      envByService: { web: { [KEY]: SECRET_TWO } },
      outcome: "applied",
    });
    expect(await warningFor("web", { [KEY]: SECRET_TWO })).toBeNull();
    expect(await warningFor("api", { [KEY]: SECRET_TWO })).toBe(
      buildStaleComposeEnvWarning({ service: "api" })
    );
  });

  test("an unknown outcome or a different env selection forgets the service instead of guessing", async () => {
    await recordUp({ [KEY]: SECRET_ONE });
    await updateProjectRuntimeServiceEnvFingerprints({
      projectDir,
      composeProject: COMPOSE_PROJECT,
      effectiveEnvName: null,
      services: ["web"],
      envByService: { web: { [KEY]: SECRET_TWO } },
      outcome: "unknown",
    });
    expect(await warningFor("web", { [KEY]: SECRET_TWO })).toBeNull();
    await updateProjectRuntimeServiceEnvFingerprints({
      projectDir,
      composeProject: COMPOSE_PROJECT,
      effectiveEnvName: "qa",
      services: ["api"],
      envByService: { api: { [KEY]: SECRET_TWO } },
      outcome: "applied",
    });
    expect(await warningFor("api", { [KEY]: SECRET_TWO })).toBeNull();
    const entry = await readProjectRuntimeStateEntry({
      projectDir,
      composeProject: COMPOSE_PROJECT,
    });
    expect(entry?.envName).toBeNull();
    expect(entry?.envFingerprint).toBeUndefined();
  });

  test("a scoped update without a stack entry writes nothing", async () => {
    await updateProjectRuntimeServiceEnvFingerprints({
      projectDir,
      composeProject: COMPOSE_PROJECT,
      effectiveEnvName: null,
      services: ["web"],
      envByService: { web: { [KEY]: SECRET_ONE } },
      outcome: "applied",
    });
    expect(
      await Bun.file(resolveProjectRuntimeStatePath({ projectDir })).exists()
    ).toBe(false);
  });
});

describe("resolver-backed refresh (W13 selection)", () => {
  async function writeLayer(opts: {
    readonly projectRoot: string;
    readonly name: string;
    readonly value: string;
  }) {
    await writeFile(
      join(opts.projectRoot, `.hack/hack.env.${opts.name}.yaml`),
      JSON.stringify({
        version: 1,
        environment: opts.name,
        secretsprovider: "project_key",
        values: { global: { [KEY]: opts.value } },
      })
    );
  }

  test("an env edit after up is detected for the default overlay and cleared by a refresh", async () => {
    const projectRoot = join(root, "project");
    await writeFile(
      join(projectDir, "hack.config.json"),
      JSON.stringify({ name: COMPOSE_PROJECT, env: { defaultOverlay: "qa" } })
    );
    await writeFile(
      join(projectDir, "docker-compose.yml"),
      "services:\n  web:\n    image: alpine:3.20\n"
    );
    await writeLayer({ projectRoot, name: "default", value: "base-value" });
    await writeLayer({ projectRoot, name: "qa", value: SECRET_ONE });
    const project = await findProjectContextAtRoot({
      projectRoot,
      projectDirName: ".hack",
    });
    if (!project) {
      throw new Error("Expected a compose project context");
    }
    const resolveNow = async (envOption: string | undefined) => {
      const resolved = await resolveModernComposeEnvOverrides({
        project,
        targetServices: ["web"],
        allServiceNames: ["web"],
        envName: resolveRequestedEnvName({ envOption }),
      });
      if (!resolved) {
        throw new Error("Expected modern env config");
      }
      return resolved;
    };

    const atUp = await resolveNow(undefined);
    expect(atUp.effectiveEnvName).toBe("qa");
    await upsertProjectRuntimeStateEntry({
      projectDir,
      entry: {
        composeProject: COMPOSE_PROJECT,
        envName: atUp.effectiveEnvName,
        updatedAt: "2026-10-12T00:00:00.000Z",
        envFingerprint: withComposeServiceEnvFingerprints({
          existing: undefined,
          services: ["web"],
          envByService: atUp.preflightEnvByService,
        }),
      },
    });
    const execWarning = async (envOption: string | undefined) => {
      const now = await resolveNow(envOption);
      return await resolveComposeExecStaleEnvWarning({
        projectDir,
        composeProject: COMPOSE_PROJECT,
        service: "web",
        currentEnv: now.preflightEnvByService.web ?? {},
      });
    };

    expect(await execWarning(undefined)).toBeNull();
    expect(await execWarning("qa")).toBeNull();

    await writeLayer({ projectRoot, name: "qa", value: SECRET_TWO });
    const warning = await execWarning(undefined);
    expect(warning).toBe(buildStaleComposeEnvWarning({ service: "web" }));
    for (const text of [KEY, SECRET_ONE, SECRET_TWO, "base-value"]) {
      expect(warning).not.toContain(text);
    }

    const refreshed = await resolveNow(undefined);
    await updateProjectRuntimeServiceEnvFingerprints({
      projectDir,
      composeProject: COMPOSE_PROJECT,
      effectiveEnvName: refreshed.effectiveEnvName,
      services: ["web"],
      envByService: refreshed.preflightEnvByService,
      outcome: "applied",
    });
    expect(await execWarning(undefined)).toBeNull();
    const stored = await readFile(
      resolveProjectRuntimeStatePath({ projectDir }),
      "utf8"
    );
    for (const text of [KEY, SECRET_ONE, SECRET_TWO]) {
      expect(stored).not.toContain(text);
    }
  });
});
