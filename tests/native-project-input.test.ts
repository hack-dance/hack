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
  selectActiveNativeProjectInput,
} from "../src/backends/native-project-input.ts";
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
  await mkdir(projectDir);
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
test("env_file and malformed modern input refuse without diagnostic contents", async () => {
  const opts = await fixture({
    services: { api: { env_file: "private-source", image: "bun:1" } },
  });
  await env(opts.projectDir, "default", {
    global: { TOKEN: { secure: "invalid-secret-canary" } },
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
test("legacy dotenv refuses and unmanaged public projects preserve original fields", async () => {
  const original = {
    services: { api: { image: "bun:1", environment: { STATIC: "tracked" } } },
  };
  const opts = await fixture(original);
  expect(
    JSON.parse((await prepareNativeProjectInput(opts)).normalizedComposeJson)
  ).toEqual(original);
  await writeFile(join(opts.projectDir, ".env"), "PRIVATE=synthetic\n");
  await expect(prepareNativeProjectInput(opts)).rejects.toMatchObject({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message: expect.stringContaining("values omitted"),
  });
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
test("plain shell references and bare names are resolved privately; everything else is left as written", async () => {
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
          // Forms that start today are not touched, whatever the shell holds.
          WITH_DEFAULT: reference("SHELL_SET", "fallback"),
          LITERAL: "plain",
          PARTIAL: `http://${reference("SHELL_SET")}:80`,
          ESCAPED: `$${reference("SHELL_SET")}`,
          // Names the runtime supplies or the credential adapters own.
          PROJECT: reference("COMPOSE_PROJECT_NAME"),
          COMPOSE_PROJECT_NAME: reference("SHELL_SET"),
          AWS_SECRET_ACCESS_KEY: reference("AWS_SECRET_ACCESS_KEY"),
          COPIED_KEY: reference("AWS_ACCESS_KEY_ID"),
          GOOGLE_APPLICATION_CREDENTIALS: null,
          // Valid names that are also Object.prototype properties.
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
      // Every entry commented out is YAML null; it must stay accepted.
      empty: { image: "bun:1", environment: null },
    },
  });
  const result = await prepareNativeProjectInput({
    ...opts,
    env: {
      SHELL_SET: PRIVATE,
      PASSED: `${PRIVATE}-passed`,
      COMPOSE_PROJECT_NAME: "other-instance",
      AWS_SECRET_ACCESS_KEY: "long-lived-credential",
      AWS_ACCESS_KEY_ID: "long-lived-id",
      GOOGLE_APPLICATION_CREDENTIALS: "credential-path",
      // Never read: no entry references it.
      UNRELATED: "unrelated-private",
    },
  });
  // Shell values are kept apart from what Hack manages, and never fingerprinted.
  expect(result.managedEnvironment).toEqual({});
  expect(JSON.parse(JSON.stringify(result.shellEnvironment))).toEqual({
    api: {
      WHOLE: PRIVATE,
      UNBRACED: PRIVATE,
      // Compose substitutes an empty string for an unset variable.
      UNSET: "",
      PASSED: `${PRIVATE}-passed`,
      // Delivered empty rather than left out, so the reviewed document is the
      // same from a shell that sets it and one that does not.
      NOT_PASSED: "",
      // Unset in this shell, and not taken from Object.prototype.
      constructor: "",
      INHERITED: "",
    },
    worker: { PASSED: `${PRIVATE}-passed`, NOT_PASSED: "", WHOLE: PRIVATE },
  });
  expect(result.normalizedComposeJson).not.toContain(PRIVATE);
  // Not read at all: neither public nor private.
  for (const hidden of [
    "unrelated-private",
    "other-instance",
    "long-lived-credential",
    "long-lived-id",
    "credential-path",
  ]) {
    expect(result.normalizedComposeJson).not.toContain(hidden);
    expect(JSON.stringify(result.shellEnvironment)).not.toContain(hidden);
  }
  const services = environments(result);
  expect(JSON.parse(JSON.stringify(services.api?.environment))).toEqual({
    WHOLE: null,
    UNBRACED: null,
    UNSET: null,
    PASSED: null,
    NOT_PASSED: null,
    constructor: null,
    INHERITED: null,
    WITH_DEFAULT: reference("SHELL_SET", "fallback"),
    LITERAL: "plain",
    PARTIAL: `http://${reference("SHELL_SET")}:80`,
    ESCAPED: `$${reference("SHELL_SET")}`,
    PROJECT: reference("COMPOSE_PROJECT_NAME"),
    COMPOSE_PROJECT_NAME: reference("SHELL_SET"),
    AWS_SECRET_ACCESS_KEY: reference("AWS_SECRET_ACCESS_KEY"),
    COPIED_KEY: reference("AWS_ACCESS_KEY_ID"),
    GOOGLE_APPLICATION_CREDENTIALS: null,
  });
  expect(services.worker?.environment).toEqual({
    PASSED: null,
    NOT_PASSED: null,
    WHOLE: null,
    KEEP: "1",
  });
  expect(services.plain?.environment).toBeUndefined();
  // No reference, no rewrite: the list form is exactly what was authored.
  expect(services.literal?.environment).toEqual(["A=1", "B=two"]);
  expect(services.empty?.environment).toBeNull();
  // Names only, never values.
  expect(result.environmentNotices).toEqual([
    "Service api: UNSET is empty because SHELL_UNSET is not set in your shell.",
    "Service api: NOT_PASSED is empty because it is not set in your shell.",
    "Service api: constructor is empty because it is not set in your shell.",
    "Service api: INHERITED is empty because toString is not set in your shell.",
    "Service worker: NOT_PASSED is empty because it is not set in your shell.",
  ]);
});

test("the reviewed document does not depend on the shell, and nothing is read unless the caller passes an environment", async () => {
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
  // Same public document from a shell that sets the variables and one that does not.
  expect(set.normalizedComposeJson).toBe(unset.normalizedComposeJson);
  // Without `env`, as exec and the stale-env check call it, the process
  // environment is not consulted.
  const previous = process.env.SHELL_TOKEN;
  process.env.SHELL_TOKEN = "ambient-private";
  try {
    const ambient = await prepareNativeProjectInput(await fixture(compose));
    expect(ambient.shellEnvironment).toEqual({
      api: { TOKEN: "", PASSED: "" },
    });
    expect(ambient.normalizedComposeJson).toBe(set.normalizedComposeJson);
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
  // Nothing of this service is taken from the shell.
  expect(result.shellEnvironment).toEqual({});
  // A reference to a managed variable is left for the runtime to refuse.
  expect(
    (environments(result).api?.environment as Record<string, unknown>).COPY
  ).toBe(reference("TOKEN"));
  for (const hidden of ["shell-private", "shell-loses"]) {
    expect(result.normalizedComposeJson).not.toContain(hidden);
  }
  expect(result.environmentNotices).toEqual([]);
});

test("merging shell values adds them to the private delivery and refuses what the runtime would refuse, naming the service", async () => {
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
    [1, "bad\0value", "contains a NUL byte"],
  ] as const) {
    const input = await prepared(count, value);
    let refusal: unknown;
    try {
      mergeNativeShellEnvironment(input);
    } catch (caught: unknown) {
      refusal = caught;
    }
    expect(refusal).toBeInstanceOf(HackCliError);
    const message = String((refusal as Error).message);
    expect(message).toContain("service api field environment");
    expect(message).toContain(cause);
    expect(message).toContain("values omitted");
    expect(message).not.toContain(value.slice(0, 12));
    expect(message).not.toContain("\0");
  }
});
