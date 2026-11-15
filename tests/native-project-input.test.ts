import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeNativeShellEnvironment,
  nativeReviewedActiveServices,
  prepareNativeProjectInput,
  requireNativeShellDeliveryFits,
  selectActiveNativeProjectInput,
} from "../src/backends/native-project-input.ts";
import { nativeEnvironmentDelivery } from "../src/backends/native-project-start.ts";
import { PROJECT_ENV_KEY_FILENAME } from "../src/constants.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import { setProjectEnvValue } from "../src/lib/project-env-config.ts";
import { restoreEnv } from "./helpers/env.ts";
import { fixtureGitEnv } from "./helpers/fixture-git.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture(compose: unknown) {
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-input-"))
  );
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { mode: 0o700 });
  const composeFile = join(projectDir, "docker-compose.yml");
  await writeFile(composeFile, JSON.stringify(compose));
  return { projectRoot, projectDir, composeFile };
}
async function env(dir: string, name: string, values: unknown) {
  await writeFile(
    join(dir, `hack.env.${name}.yaml`),
    JSON.stringify({
      version: 1,
      environment: name,
      secretsprovider: "project_key",
      values,
    })
  );
}

test("empty service environments still normalize managed keys without exposing their values", async () => {
  const opts = await fixture({
    services: { app: { image: "example", environment: null } },
  });
  await env(opts.projectDir, "default", {
    app: { TOKEN: "synthetic-managed-value" },
  });
  const input = await prepareNativeProjectInput(opts);
  expect(JSON.parse(input.normalizedComposeJson)).toMatchObject({
    services: { app: { environment: { TOKEN: null } } },
  });
  expect(input.managedEnvironment).toEqual({
    app: { TOKEN: "synthetic-managed-value" },
  });
  expect(input.normalizedComposeJson).not.toContain("synthetic-managed-value");
});
test("modern values stay private while original contracts and exact input hash survive", async () => {
  const original = {
    name: "demo",
    services: {
      api: {
        image: "bun:1",
        environment: ["KEEP=tracked", "TOKEN=placeholder"],
        volumes: ["../:/app:ro"],
        extra_hosts: ["db:host-gateway"],
        build: { context: ".." },
        ports: ["3000:3000"],
      },
    },
    networks: { default: { internal: true } },
  };
  const opts = await fixture(original);
  await env(opts.projectDir, "default", {
    global: { TOKEN: "synthetic-private" },
    host: { HOST_ONLY: "host-private" },
  });
  const before = await readFile(opts.composeFile);
  const names = await readdir(opts.projectDir);
  const result = await prepareNativeProjectInput(opts);
  const parsed = JSON.parse(result.normalizedComposeJson);
  expect(parsed.services.api).toEqual({
    ...original.services.api,
    environment: { KEEP: "tracked", TOKEN: null },
  });
  expect(parsed.networks).toEqual(original.networks);
  expect(result.originalSha256).toBe(
    createHash("sha256").update(before).digest("hex")
  );
  expect(result.normalizedComposeJson).not.toContain("synthetic-private");
  expect(result.normalizedComposeJson).not.toContain("host-private");
  expect(result.managedEnvironment.api?.TOKEN).toBe("synthetic-private");
  expect(result.lifecycleHostEnvironment.HOST_ONLY).toBe("host-private");
  expect(await readFile(opts.composeFile)).toEqual(before);
  expect(await readdir(opts.projectDir)).toEqual(names);
});
test("only values stored as secrets are reported as managed secret values", async () => {
  const opts = await fixture({
    services: { web: { image: "bun:1" }, worker: { image: "bun:1" } },
  });
  await writeFile(
    join(opts.projectRoot, PROJECT_ENV_KEY_FILENAME),
    "synthetic-key"
  );
  const set = async (
    scope: string,
    key: string,
    value: string,
    secret: boolean
  ) =>
    await setProjectEnvValue({
      projectRoot: opts.projectRoot,
      projectDir: opts.projectDir,
      envName: null,
      scope,
      key,
      value,
      secret,
    });
  await set("global", "TOKEN", "synthetic-global-secret", true);
  await set("worker", "WORKER_KEY", "synthetic-worker-secret", true);
  await set("web", "MODE", "production", false);
  const result = await prepareNativeProjectInput(opts);
  expect([...(result.managedSecretValues ?? [])].sort()).toEqual([
    "synthetic-global-secret",
    "synthetic-worker-secret",
  ]);
  expect(result.normalizedComposeJson).not.toContain("synthetic-");
});

test("fourteen services and 110 managed variables each preserve overlay selection", async () => {
  const services = Object.fromEntries(
    Array.from({ length: 14 }, (_, i) => [`service${i}`, { image: "bun:1" }])
  );
  const opts = await fixture({ services });
  const values = Object.fromEntries(
    Array.from({ length: 110 }, (_, i) => [`KEY_${i}`, `synthetic-${i}`])
  );
  await env(opts.projectDir, "default", { global: values });
  await env(opts.projectDir, "qa", { global: { KEY_0: "overlay-value" } });
  const result = await prepareNativeProjectInput({ ...opts, envName: "qa" });
  expect(result.effectiveEnvName).toBe("qa");
  expect(Object.keys(result.managedEnvironment)).toHaveLength(14);
  for (const value of Object.values(result.managedEnvironment)) {
    expect(Object.keys(value)).toHaveLength(110);
    expect(value.KEY_0).toBe("overlay-value");
  }
  expect(result.normalizedComposeJson).not.toContain("synthetic-");
  expect(result.normalizedComposeJson).not.toContain("overlay-value");
});
test("missing env_file and malformed modern input refuse without diagnostic contents", async () => {
  const opts = await fixture({
    services: { api: { env_file: "private-source", image: "bun:1" } },
  });
  await env(opts.projectDir, "default", {
    global: { TOKEN: "managed-synthetic" },
  });
  await expect(prepareNativeProjectInput(opts)).rejects.toMatchObject({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message: expect.stringContaining("values omitted"),
  });
  await writeFile(opts.composeFile, '{"services":{"api":{"image":"bun:1"}}}');
  await writeFile(
    join(opts.projectDir, "hack.env.default.yaml"),
    "secret-canary: ["
  );
  try {
    await prepareNativeProjectInput(opts);
    throw new Error("unexpected success");
  } catch (error) {
    expect(String(error)).not.toContain("secret-canary");
    expect(String(error)).toContain("values omitted");
  }
});
test("unreferenced dotenv does not inject values and public projects preserve original fields", async () => {
  const original = {
    services: { api: { image: "bun:1", environment: { STATIC: "tracked" } } },
  };
  const opts = await fixture(original);
  expect(
    JSON.parse((await prepareNativeProjectInput(opts)).normalizedComposeJson)
  ).toEqual(original);
  await writeFile(join(opts.projectDir, ".env"), "PRIVATE=synthetic\n", {
    mode: 0o644,
  });
  const withDotenv = await prepareNativeProjectInput(opts);
  expect(JSON.parse(withDotenv.normalizedComposeJson)).toEqual(original);
  expect(withDotenv.shellEnvironment).toEqual({});
});

test("the effective env is the requested or default env even without managed env files", async () => {
  const opts = await fixture({ services: { api: { image: "bun:1" } } });
  const effective = async (envName?: string | null) => {
    const input = await prepareNativeProjectInput({ ...opts, envName });
    expect(input.environmentFiles).toEqual([]);
    expect(input.managedEnvironment).toEqual({});
    return input.effectiveEnvName;
  };
  expect(await effective()).toBeNull();
  expect(await effective("qa")).toBe("qa");
  await writeFile(
    join(opts.projectDir, "hack.config.json"),
    JSON.stringify({ name: "fixture", env: { defaultOverlay: "qa" } })
  );
  expect(await effective()).toBe("qa");
  expect(await effective("stage")).toBe("stage");
  // An explicit base selection still overrides the project default.
  expect(await effective(null)).toBeNull();
});

test("linked worktree inherits primary local environment and observes checkout overrides", async () => {
  const oldCI = process.env.CI;
  const oldMode = process.env.HACK_EXECUTION_MODE;
  const opts = await fixture({ services: { api: { image: "bun:1" } } });
  const git = async (args: string[]) => {
    const child = Bun.spawn(["git", ...args], {
      env: fixtureGitEnv(),
      cwd: opts.projectRoot,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await child.exited).toBe(0);
  };
  const linked = `${opts.projectRoot}-linked`;
  roots.push(linked);
  try {
    Reflect.deleteProperty(process.env, "CI");
    Reflect.deleteProperty(process.env, "HACK_EXECUTION_MODE");
    await writeFile(
      join(opts.projectDir, "hack.config.json"),
      '{"name":"native-test"}'
    );
    await env(opts.projectDir, "default", { global: { VALUE: "tracked" } });
    await git(["init", "-b", "main"]);
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    await git(["worktree", "add", "-b", "linked", linked]);
    await env(opts.projectDir, "local", {
      global: { VALUE: "inherited-private" },
    });
    const childOpts = {
      projectRoot: linked,
      projectDir: join(linked, ".hack"),
      composeFile: join(linked, ".hack/docker-compose.yml"),
    };
    expect(
      (await prepareNativeProjectInput(childOpts)).managedEnvironment.api?.VALUE
    ).toBe("inherited-private");
    await env(opts.projectDir, "local", {
      global: { VALUE: "updated-private" },
    });
    expect(
      (await prepareNativeProjectInput(childOpts)).managedEnvironment.api?.VALUE
    ).toBe("updated-private");
    await env(childOpts.projectDir, "local", {
      global: { VALUE: "checkout-private" },
    });
    const result = await prepareNativeProjectInput(childOpts);
    expect(result.managedEnvironment.api?.VALUE).toBe("checkout-private");
    expect(result.environmentFiles).toContain(
      join(opts.projectDir, "hack.env.local.yaml")
    );
    expect(result.normalizedComposeJson).not.toContain("private");
  } finally {
    restoreEnv("CI", oldCI);
    restoreEnv("HACK_EXECUTION_MODE", oldMode);
  }
});

test("managed values reach only the reviewed profile-active services", async () => {
  // Synthetic shape: an always-on service and an optional profile service,
  // both receiving one project-wide managed value.
  const opts = await fixture({
    services: {
      app: { image: "alpine:3", entrypoint: ["/bin/sleep"], command: ["60"] },
      extra: {
        profiles: ["extra"],
        image: "alpine:3",
        entrypoint: ["/bin/sleep"],
        command: ["60"],
      },
    },
  });
  await env(opts.projectDir, "default", {
    global: { GREETING: "synthetic-hello" },
  });
  const input = await prepareNativeProjectInput(opts);
  // Normalization still declares the key on every authored service, so the
  // reviewed plan is identical whichever profiles are selected.
  const parsed = JSON.parse(input.normalizedComposeJson);
  expect(parsed.services.app.environment).toEqual({ GREETING: null });
  expect(parsed.services.extra.environment).toEqual({ GREETING: null });
  expect(Object.keys(input.managedEnvironment).sort()).toEqual([
    "app",
    "extra",
  ]);

  const inactive = selectActiveNativeProjectInput({
    input,
    reviewedPlan: {
      services: { app: { active: true }, extra: { active: false } },
    },
  });
  expect(inactive.managedEnvironment).toEqual({
    app: { GREETING: "synthetic-hello" },
  });
  expect(inactive.normalizedComposeJson).toBe(input.normalizedComposeJson);
  expect(inactive.serviceNames).toEqual(input.serviceNames);

  const selected = selectActiveNativeProjectInput({
    input,
    reviewedPlan: {
      services: { app: { active: true }, extra: { active: true } },
    },
  });
  expect(Object.keys(selected.managedEnvironment).sort()).toEqual([
    "app",
    "extra",
  ]);
});

test("an absent or malformed reviewed plan delivers no managed values", () => {
  for (const reviewedPlan of [
    undefined,
    null,
    {},
    { services: [] },
    { services: { app: { active: "true" } } },
    { services: { app: null } },
  ]) {
    expect(nativeReviewedActiveServices(reviewedPlan).size).toBe(0);
  }
  expect([
    ...nativeReviewedActiveServices({
      services: { app: { active: true }, other: { active: false } },
    }),
  ]).toEqual(["app"]);
});

test("input refusals name the cause, service and field without values", async () => {
  const opts = await fixture({
    services: { api: { env_file: "private-source", image: "bun:1" } },
  });
  await expect(prepareNativeProjectInput(opts)).rejects.toMatchObject({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message: expect.stringContaining("service api field env_file"),
  });
  await writeFile(
    opts.composeFile,
    JSON.stringify({
      services: {
        api: { image: "bun:1", environment: ["OK=1", "OK=private-dup"] },
      },
    })
  );
  await env(opts.projectDir, "default", { global: { TOKEN: "managed" } });
  const duplicate = await prepareNativeProjectInput(opts).catch(
    (error: unknown) => error
  );
  expect(duplicate).toBeInstanceOf(HackCliError);
  expect((duplicate as HackCliError).code).toBe("E_NATIVE_PROJECT_UNSUPPORTED");
  expect((duplicate as HackCliError).message).toContain(
    "service api field environment"
  );
  expect((duplicate as HackCliError).message).not.toContain("private-dup");
  await writeFile(opts.composeFile, "services: [unclosed");
  await expect(prepareNativeProjectInput(opts)).rejects.toMatchObject({
    message: expect.stringContaining("not valid UTF-8 YAML"),
  });
  await writeFile(opts.composeFile, '{"name":"no-services"}');
  await expect(prepareNativeProjectInput(opts)).rejects.toMatchObject({
    message: expect.stringContaining("no services mapping"),
  });
  await rm(opts.composeFile);
  await expect(prepareNativeProjectInput(opts)).rejects.toMatchObject({
    message: expect.stringContaining("Compose file must be a regular"),
  });
});
test("a missing project env key is reported as such, not as invalid Compose", async () => {
  const oldKey = process.env.HACK_ENV_SECRET_KEY;
  restoreEnv("HACK_ENV_SECRET_KEY", undefined);
  try {
    const opts = await fixture({ services: { api: { image: "bun:1" } } });
    await env(opts.projectDir, "default", {
      global: { TOKEN: { secure: "synthetic-ciphertext-canary" } },
    });
    const error = await prepareNativeProjectInput(opts).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(HackCliError);
    const { code, message } = error as HackCliError;
    expect(code).toBe("E_CONFIG_INVALID");
    expect(message).toContain("project env key is missing");
    expect(message).toContain("HACK_ENV_SECRET_KEY");
    // HACK-2069: encrypted values exist, so a new key would not decrypt them;
    // the hint says to bring the existing key, never to create one.
    expect(message).toContain("Copy .hack.secret.key from a machine");
    expect(message).toContain(
      'Do not create a new key with "hack env add --secret"'
    );
    expect(message).not.toContain("to generate it");
    expect(message).not.toContain("unsupported or invalid Compose");
    expect(message).not.toContain("synthetic-ciphertext-canary");
  } finally {
    restoreEnv("HACK_ENV_SECRET_KEY", oldKey);
  }
});

/** A Compose reference to `name`, built so this file has no template placeholders. */
function reference(name: string, word?: string): string {
  return word === undefined ? `$\{${name}}` : `$\{${name}:-${word}}`;
}

/** The normalized `environment` of each service. */
function environments(result: { readonly normalizedComposeJson: string }) {
  return (
    JSON.parse(result.normalizedComposeJson) as {
      services: Record<string, { environment?: unknown }>;
    }
  ).services;
}

/**
 * Compose reads a `NAME` reference and a bare `NAME` entry from the caller's
 * shell. Native does the same for a service's `environment`, without ever
 * writing the value into the public document: the entry stays a reference and
 * the value is kept apart, for the private delivery.
 */
test("shell expressions are private, unresolved bare names unset, and public literals stay authored", async () => {
  const PRIVATE = "synthetic-shell-value";
  const opts = await fixture({
    services: {
      api: {
        image: "bun:1",
        environment: {
          WHOLE: reference("SHELL_SET"),
          UNBRACED: "$SHELL_SET",
          UNSET: reference("SHELL_UNSET"),
          PASSED: null,
          NOT_PASSED: null,
          WITH_DEFAULT: reference("SHELL_SET", "fallback"),
          LITERAL: "plain",
          PARTIAL: `http://${reference("SHELL_SET")}:80`,
          ESCAPED: `$${reference("SHELL_SET")}`,
          PROJECT: reference("COMPOSE_PROJECT_NAME"),
          constructor: reference("constructor"),
          INHERITED: reference("toString"),
        },
      },
      worker: {
        image: "bun:1",
        environment: [
          "PASSED",
          "NOT_PASSED",
          `WHOLE=${reference("SHELL_SET")}`,
          "KEEP=1",
        ],
      },
      plain: { image: "bun:1" },
      literal: { image: "bun:1", environment: ["A=1", "B=two"] },
      empty: { image: "bun:1", environment: null },
    },
  });
  const result = await prepareNativeProjectInput({
    ...opts,
    env: {
      SHELL_SET: PRIVATE,
      PASSED: `${PRIVATE}-passed`,
      COMPOSE_PROJECT_NAME: "other-instance",
      UNRELATED: "unrelated-private",
    },
  });
  expect(result.managedEnvironment).toEqual({});
  expect(result.shellEnvironment).toEqual({
    api: {
      WHOLE: PRIVATE,
      UNBRACED: PRIVATE,
      UNSET: "",
      PASSED: `${PRIVATE}-passed`,
      WITH_DEFAULT: PRIVATE,
      PARTIAL: `http://${PRIVATE}:80`,
      constructor: "",
      INHERITED: "",
    },
    worker: { PASSED: `${PRIVATE}-passed`, WHOLE: PRIVATE },
  });
  const services = environments(result);
  expect(services.api?.environment).toEqual({
    WHOLE: null,
    UNBRACED: null,
    UNSET: null,
    PASSED: null,
    WITH_DEFAULT: null,
    LITERAL: "plain",
    PARTIAL: null,
    ESCAPED: "$${SHELL_SET}",
    PROJECT: reference("COMPOSE_PROJECT_NAME"),
    constructor: null,
    INHERITED: null,
  });
  expect(
    JSON.parse(result.normalizedComposeJson).services.api[
      "x-hack-unset-environment"
    ]
  ).toEqual(["NOT_PASSED"]);
  expect(services.worker?.environment).toEqual({
    PASSED: null,
    WHOLE: null,
    KEEP: "1",
  });
  expect(services.plain?.environment).toBeUndefined();
  expect(services.literal?.environment).toEqual(["A=1", "B=two"]);
  expect(services.empty?.environment).toBeNull();
  expect(result.environmentNotices).toHaveLength(5);
  expect(JSON.stringify(result.environmentNotices)).toContain(
    "key NOT_PASSED: an unresolved input is unset"
  );
  for (const hidden of [PRIVATE, "other-instance", "unrelated-private"]) {
    expect(result.normalizedComposeJson).not.toContain(hidden);
    expect(JSON.stringify(result.environmentNotices)).not.toContain(hidden);
  }
});

test("Hack key material stays runtime-owned without files and refuses with files, never reading the caller", async () => {
  for (const key of ["HACK_ENV_SECRET_KEY", "HACK_GATEWAY_TOKEN"]) {
    const opts = await fixture({
      services: {
        api: { image: "bun:1", environment: { COPY: reference(key) } },
      },
    });
    const caller = Object.defineProperty({}, key, {
      enumerable: true,
      get() {
        throw new Error("private getter must never be invoked");
      },
    });
    const input = await prepareNativeProjectInput({ ...opts, env: caller });
    expect(environments(input).api?.environment).toEqual({
      COPY: reference(key),
    });
    expect(input.shellEnvironment).toEqual({});
    await writeFile(join(opts.projectDir, ".env"), "", { mode: 0o600 });
    await expect(
      prepareNativeProjectInput({ ...opts, env: caller })
    ).rejects.toThrow("protected variable");
  }
});

test("unset names affect only names in the document; ambient values require an explicit caller environment", async () => {
  const compose = {
    services: {
      api: {
        image: "bun:1",
        environment: { TOKEN: reference("SHELL_TOKEN"), PASSED: null },
      },
    },
  };
  const set = await prepareNativeProjectInput({
    ...(await fixture(compose)),
    env: { SHELL_TOKEN: "shell-private", PASSED: "passed-private" },
  });
  const unset = await prepareNativeProjectInput({
    ...(await fixture(compose)),
    env: {},
  });
  // Bare unset is distinct from an empty string and only the name enters identity.
  expect(set.normalizedComposeJson).not.toBe(unset.normalizedComposeJson);
  expect(
    JSON.parse(unset.normalizedComposeJson).services.api[
      "x-hack-unset-environment"
    ]
  ).toEqual(["PASSED"]);
  // Without `env`, as exec and the stale-env check call it, the process
  // environment is not consulted.
  const previous = process.env.SHELL_TOKEN;
  process.env.SHELL_TOKEN = "ambient-private";
  try {
    const ambient = await prepareNativeProjectInput(await fixture(compose));
    expect(ambient.shellEnvironment).toEqual({
      api: { TOKEN: "" },
    });
    expect(ambient.normalizedComposeJson).toBe(unset.normalizedComposeJson);
  } finally {
    restoreEnv("SHELL_TOKEN", previous);
  }
});

test("a key Hack manages is delivered from managed env, never from the shell", async () => {
  const opts = await fixture({
    services: {
      api: {
        image: "bun:1",
        environment: [
          "KEEP=tracked",
          `TOKEN=${reference("SHELL_TOKEN")}`,
          "FROM_MANAGED",
          `COPY=${reference("TOKEN")}`,
        ],
      },
    },
  });
  await env(opts.projectDir, "default", {
    global: { TOKEN: "managed-private", FROM_MANAGED: "managed-too" },
  });
  const result = await prepareNativeProjectInput({
    ...opts,
    env: {
      SHELL_TOKEN: "shell-private",
      FROM_MANAGED: "shell-loses",
      TOKEN: "shell-loses-too",
    },
  });
  expect(result.managedEnvironment.api).toEqual({
    TOKEN: "managed-private",
    FROM_MANAGED: "managed-too",
  });
  // A global managed value participates in interpolation above shell and dotenv.
  expect(result.shellEnvironment).toEqual({ api: { COPY: "managed-private" } });
  expect(
    (environments(result).api?.environment as Record<string, unknown>).COPY
  ).toBeNull();
  for (const hidden of ["shell-private", "shell-loses"]) {
    expect(result.normalizedComposeJson).not.toContain(hidden);
  }
  expect(result.environmentNotices).toEqual([]);
});

test("merged shell values join the private delivery, and a delivery the runtime would refuse is refused first, naming the service", async () => {
  const compose = (count: number) => ({
    services: {
      api: {
        image: "bun:1",
        environment: Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `KEY_${index}`,
            reference("BIG"),
          ])
        ),
      },
    },
  });
  const prepared = async (count: number, value: string) =>
    await prepareNativeProjectInput({
      ...(await fixture(compose(count))),
      env: { BIG: value },
    });
  const merged = mergeNativeShellEnvironment(await prepared(2, "small"));
  expect(merged.managedEnvironment).toEqual({
    api: { KEY_0: "small", KEY_1: "small" },
  });
  expect(merged.shellEnvironment).toEqual({});
  expect(merged.shellServices).toEqual(["api"]);
  // Merging again changes nothing, and a delivery within the limits passes.
  expect(mergeNativeShellEnvironment(merged)).toBe(merged);
  expect(() => requireNativeShellDeliveryFits(merged)).not.toThrow();
  // An input with nothing from the shell is returned as it is.
  const untouched = await prepareNativeProjectInput(
    await fixture({ services: { api: { image: "bun:1" } } })
  );
  expect(mergeNativeShellEnvironment(untouched)).toBe(untouched);
  for (const [count, value, cause] of [
    // Two values that each fit, but not together.
    [2, "x".repeat(20 * 1024), "are over 32 KiB together"],
    // JSON escaping counts: the runtime receives the escaped form.
    [1, '"'.repeat(17 * 1024), "are over 32 KiB together"],
    [257, "#", "more than 256 variables"],
  ] as const) {
    const input = await prepared(count, value);
    const delivery = mergeNativeShellEnvironment(input);
    let refusal: unknown;
    try {
      requireNativeShellDeliveryFits(delivery);
    } catch (caught: unknown) {
      refusal = caught;
    }
    // A service the selected profiles leave out is not delivered, so it is not counted.
    expect(() =>
      requireNativeShellDeliveryFits(
        selectActiveNativeProjectInput({
          input: delivery,
          reviewedPlan: { services: { api: { active: false } } },
        })
      )
    ).not.toThrow();
    expect(refusal).toBeInstanceOf(HackCliError);
    const message = String((refusal as Error).message);
    expect(message).toContain("service api field environment");
    expect(message).toContain(cause);
    expect(message).toContain("values omitted");
    expect(message).not.toContain(value.slice(0, 12));
    expect(message).not.toContain("\0");
  }
});

async function aggregateShellInput(count: number, value: string) {
  return mergeNativeShellEnvironment(
    await prepareNativeProjectInput({
      ...(await fixture({
        services: Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `app${index}`,
            { image: "bun:1", environment: { TOKEN: reference("BIG") } },
          ])
        ),
      })),
      env: { BIG: value },
    })
  );
}

const aggregateSelection = (count: number) => ({
  planId: "f".repeat(64),
  run: "a".repeat(32),
  reviewedPlan: {
    services: Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [
        `app${index}`,
        { active: index < count },
      ])
    ),
  },
});

test("aggregate private delivery counts active services and encoded file members", async () => {
  const input = await aggregateShellInput(9, "p".repeat(30 * 1024));
  for (const count of [8, 9]) {
    const selection = aggregateSelection(count);
    const active = selectActiveNativeProjectInput({ input, ...selection });
    const bytes = nativeEnvironmentDelivery({ input: active, ...selection })
      .payload?.length;
    for (const values of Object.values(active.managedEnvironment)) {
      expect(Buffer.byteLength(JSON.stringify(values))).toBeLessThan(32 * 1024);
    }
    if (count === 8) {
      expect(bytes).toBeLessThan(256 * 1024);
      expect(() => requireNativeShellDeliveryFits(active)).not.toThrow();
    } else {
      expect(bytes).toBeGreaterThan(256 * 1024);
      expect(() => requireNativeShellDeliveryFits(active)).toThrow(
        "over 256 KiB"
      );
    }
  }
  const members = [
    {
      name: "credential",
      target: "/run/secrets/credential",
      content: Buffer.alloc(16 * 1024, 0x66),
    },
  ];
  const selection = aggregateSelection(8);
  const inactiveFile = selectActiveNativeProjectInput({
    input: { ...input, managedFiles: { app8: members } },
    ...selection,
  });
  expect(
    nativeEnvironmentDelivery({ input: inactiveFile, ...selection }).payload
      ?.length
  ).toBeLessThan(256 * 1024);
  expect(() => requireNativeShellDeliveryFits(inactiveFile)).not.toThrow();
  const activeFile = { ...inactiveFile, managedFiles: { app0: members } };
  expect(
    nativeEnvironmentDelivery({ input: activeFile, ...selection }).payload
      ?.length
  ).toBeGreaterThan(256 * 1024);
  expect(() => requireNativeShellDeliveryFits(activeFile)).toThrow(
    "over 256 KiB"
  );
});

test("aggregate private delivery admits the exact wire limit and counts UTF-8 beyond it", async () => {
  const input = await aggregateShellInput(8, "p".repeat(32_700));
  const services = Object.fromEntries(
    Object.entries(input.managedEnvironment).map(([name, values]) => [
      name,
      { ...values },
    ])
  );
  const selection = aggregateSelection(8);
  const delivery = { ...input, managedEnvironment: services };
  const initialBytes =
    nativeEnvironmentDelivery({ input: delivery, ...selection }).payload
      ?.length ?? 0;
  const padding = 256 * 1024 - initialBytes;
  expect(padding).toBeGreaterThan(0);
  for (const [index, values] of Object.values(services).entries()) {
    values.TOKEN += "p".repeat(
      Math.floor(padding / 8) + (index < padding % 8 ? 1 : 0)
    );
    expect(Buffer.byteLength(JSON.stringify(values))).toBeLessThanOrEqual(
      32 * 1024
    );
  }
  expect(
    nativeEnvironmentDelivery({ input: delivery, ...selection }).payload?.length
  ).toBe(256 * 1024);
  expect(() => requireNativeShellDeliveryFits(delivery)).not.toThrow();
  const first = Object.values(services)[0];
  if (!first) {
    throw new Error("Missing test service");
  }
  first.TOKEN += "é";
  expect(
    nativeEnvironmentDelivery({ input: delivery, ...selection }).payload?.length
  ).toBe(256 * 1024 + 2);
  expect(() => requireNativeShellDeliveryFits(delivery)).toThrow(
    "over 256 KiB"
  );
});
