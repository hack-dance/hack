import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptNativeAwsEnvironment } from "../src/backends/native-aws-environment.ts";
import { adaptNativeGcloudEnvironment } from "../src/backends/native-gcloud-environment.ts";
import { nativePrivateEnvironmentPayload } from "../src/backends/native-private-environment-payload.ts";
import {
  mergeNativeShellEnvironment,
  prepareNativeProjectInput,
  requireNativeShellDeliveryFits,
  selectActiveNativeProjectInput,
} from "../src/backends/native-project-input.ts";

const FILE = "synthetic-file-value-canary";
const DOTENV = "synthetic-dotenv-value-canary";
const SHELL = "synthetic-shell-value-canary";
const MANAGED = "synthetic-managed-value-canary";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture(
  service: Record<string, unknown>,
  extra: Record<string, unknown> = {}
) {
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-compose-env-"))
  );
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { mode: 0o700 });
  const composeFile = join(projectDir, "docker-compose.yml");
  await writeFile(
    composeFile,
    JSON.stringify({
      services: { app: { image: "alpine:3.21", ...service } },
      ...extra,
    })
  );
  const source = async (path: string, text: string) =>
    await writeFile(join(projectDir, path), text, { mode: 0o600 });
  return { projectRoot, projectDir, composeFile, source };
}
async function managed(projectDir: string, values: unknown) {
  await writeFile(
    join(projectDir, "hack.env.default.yaml"),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values,
    })
  );
}
function publicService(
  input: Awaited<ReturnType<typeof prepareNativeProjectInput>>
) {
  return JSON.parse(input.normalizedComposeJson).services.app;
}

test("service environment beats ordered files; interpolation is private and dotenv does not inject", async () => {
  const f = await fixture({
    env_file: "service.env",
    environment: {
      OVERRIDE: "explicit",
      EMPTY: "",
      PASSED: null,
      ABSENT: null,
      INTERPOLATED: "prefix-${SOURCE}",
    },
  });
  await f.source(".env", `SOURCE=${DOTENV}\nNOT_INJECTED=${DOTENV}\n`);
  await f.source(
    "service.env",
    `FILE=${FILE}\nOVERRIDE=${FILE}\nEMPTY=${FILE}\nABSENT=${FILE}\nCOPY=\${SOURCE}\n`
  );
  const original = await readFile(f.composeFile);
  const input = await prepareNativeProjectInput({
    ...f,
    env: { SOURCE: SHELL, PASSED: SHELL },
  });
  expect(input.managedEnvironment).toEqual({});
  expect(input.shellEnvironment).toEqual({
    app: { FILE, COPY: SHELL, PASSED: SHELL, INTERPOLATED: `prefix-${SHELL}` },
  });
  expect(publicService(input)).toEqual({
    image: "alpine:3.21",
    environment: {
      FILE: null,
      COPY: null,
      OVERRIDE: "explicit",
      EMPTY: "",
      PASSED: null,
      INTERPOLATED: null,
    },
    "x-hack-unset-environment": ["ABSENT"],
  });
  expect(publicService(input).environment).not.toHaveProperty("NOT_INJECTED");
  expect(await readFile(f.composeFile)).toEqual(original);
  for (const canary of [FILE, DOTENV, SHELL]) {
    expect(input.normalizedComposeJson).not.toContain(canary);
    expect(input.originalSha256).not.toContain(canary);
    expect(JSON.stringify(input.environmentNotices)).not.toContain(canary);
  }
  const delivered = mergeNativeShellEnvironment(input);
  expect(() => requireNativeShellDeliveryFits(delivered)).not.toThrow();
  const wire = nativePrivateEnvironmentPayload({
    services: delivered.managedEnvironment,
    planId: "a".repeat(64),
    run: "b".repeat(32),
  });
  expect(JSON.parse(wire.toString()).services.app.FILE).toBe(FILE);
});

test("short/list/long optional/raw and duplicate entries preserve Compose order", async () => {
  const f = await fixture({
    env_file: [
      { path: "one.env", format: "" },
      { path: "missing.env", required: false },
      { path: "two.env", format: "raw" },
      "one.env",
    ],
  });
  await f.source("one.env", `VALUE=${FILE}\nBARE\n`);
  await f.source(
    "two.env",
    'VALUE="${SOURCE}" # literal\nRAW="${SOURCE}" # literal\n'
  );
  const input = await prepareNativeProjectInput(f);
  expect(input.shellEnvironment).toEqual({
    app: { VALUE: FILE, RAW: '"${SOURCE}" # literal' },
  });
  expect(publicService(input)).not.toHaveProperty("env_file");
});

test("Compose rejects the literal default format name", async () => {
  const f = await fixture({
    env_file: { path: "service.env", format: "default" },
  });
  await f.source("service.env", `TOKEN=${FILE}\n`);
  await expect(prepareNativeProjectInput(f)).rejects.toThrow("format");
});

test("explicit cloud values may seed env-file expansion without reading cloud shell variables", async () => {
  const f = await fixture({
    env_file: "service.env",
    environment: { AWS_REGION: "explicit-region" },
  });
  await f.source("service.env", "REGION=${AWS_REGION}\n");
  const input = await prepareNativeProjectInput({
    ...f,
    env: { AWS_REGION: SHELL },
  });
  expect(input.shellEnvironment).toEqual({
    app: { REGION: "explicit-region" },
  });
  expect(input.normalizedComposeJson).not.toContain(SHELL);
});

test("file-backed names do not capture service defaults from the project interpolation context", async () => {
  const f = await fixture({
    env_file: "service.env",
    environment: {
      URL: "${HOST:-localhost}",
      ALT: "${HOST:+present}",
      DOLLAR: "${HOST:-$$LITERAL}",
      UNSELECTED: "${OTHER:+${HOST}}",
      UNAFFECTED: "${OTHER:-public}",
    },
  });
  await f.source("service.env", `HOST=${FILE}\n`);
  const first = await prepareNativeProjectInput(f);
  expect(first.shellEnvironment).toEqual({ app: { HOST: FILE } });
  expect(publicService(first).environment).toEqual({
    HOST: null,
    URL: "localhost",
    ALT: "",
    DOLLAR: "$$LITERAL",
    UNSELECTED: "",
    UNAFFECTED: "${OTHER:-public}",
  });
  expect(first.normalizedComposeJson).not.toContain(FILE);
  await f.source("service.env", `HOST=${DOTENV}\n`);
  const second = await prepareNativeProjectInput(f);
  expect(second.normalizedComposeJson).toBe(first.normalizedComposeJson);
  expect(second.shellEnvironment).toEqual({ app: { HOST: DOTENV } });
});

test("a default combined with a private source stays private after file bindings are introduced", async () => {
  const f = await fixture({
    env_file: "service.env",
    environment: { URL: "${HOST:-localhost}/${SOURCE}" },
  });
  await f.source("service.env", `HOST=${FILE}\n`);
  await f.source(".env", `SOURCE=${DOTENV}\n`);
  const input = await prepareNativeProjectInput(f);
  expect(publicService(input).environment).toEqual({ HOST: null, URL: null });
  expect(input.shellEnvironment).toEqual({
    app: { HOST: FILE, URL: `localhost/${DOTENV}` },
  });
  expect(input.normalizedComposeJson).not.toContain(FILE);
  expect(input.normalizedComposeJson).not.toContain(DOTENV);
});

test.each([
  {
    field: "command",
    authored: [
      "echo",
      "${HOST:-localhost}",
      "${HOST:+present}",
      "${OTHER:+${HOST}}",
      "${HOST:-$$LITERAL}",
      "${COMPOSE_PROJECT_NAME}",
      "${OTHER:-untouched}",
      "$$HOST",
    ],
    expected: [
      "echo",
      "localhost",
      "",
      "",
      "$$LITERAL",
      "${COMPOSE_PROJECT_NAME}",
      "${OTHER:-untouched}",
      "$$HOST",
    ],
  },
  {
    field: "command",
    authored: "echo ${HOST:-localhost}",
    expected: "echo localhost",
  },
  { field: "entrypoint", authored: ["${HOST:-echo}"], expected: ["echo"] },
  { field: "entrypoint", authored: "${HOST:-echo}", expected: "echo" },
  { field: "user", authored: "${HOST:-1000}", expected: "1000" },
  {
    field: "healthcheck",
    authored: { test: ["CMD", "echo", "${HOST:-healthy}"] },
    expected: { test: ["CMD", "echo", "healthy"] },
  },
  {
    field: "healthcheck",
    authored: { test: "echo ${HOST:-healthy}" },
    expected: { test: "echo healthy" },
  },
  {
    field: "extra_hosts",
    authored: ["relay.hack:${HOST:-host-gateway}"],
    expected: ["relay.hack:host-gateway"],
  },
  {
    field: "extra_hosts",
    authored: { "relay.hack": "${HOST:-host-gateway}" },
    expected: { "relay.hack": "host-gateway" },
  },
  {
    field: "extra_hosts",
    authored: { "${HOST:-relay.hack}": "host-gateway" },
    expected: { "relay.hack": "host-gateway" },
  },
  {
    field: "extra_hosts",
    authored: { "${OTHER:+${HOST}}relay.hack": "host-gateway" },
    expected: { "relay.hack": "host-gateway" },
  },
])("public executable defaults use project context before file bindings (%s)", async ({
  field,
  authored,
  expected,
}) => {
  const f = await fixture({ env_file: "service.env", [field]: authored });
  await f.source("service.env", `HOST=${FILE}\n`);
  const first = await prepareNativeProjectInput(f);
  expect(publicService(first)[field]).toEqual(expected);
  expect(first.shellEnvironment).toEqual({ app: { HOST: FILE } });
  expect(first.normalizedComposeJson).not.toContain(FILE);
  await f.source("service.env", `HOST=${DOTENV}\n`);
  const second = await prepareNativeProjectInput(f);
  expect(second.normalizedComposeJson).toBe(first.normalizedComposeJson);
  expect(second.shellEnvironment).toEqual({ app: { HOST: DOTENV } });
});

test("extra_hosts keys that freeze to one hostname refuse without echoing file values", async () => {
  const f = await fixture({
    env_file: "service.env",
    extra_hosts: {
      "${HOST:-relay.hack}": "host-gateway",
      "relay.hack": "host-gateway",
    },
  });
  await f.source("service.env", `HOST=${FILE}\n`);
  const error: unknown = await prepareNativeProjectInput(f).catch(
    (caught: unknown) => caught
  );
  expect(String(error)).toContain("hostnames must remain distinct");
  expect(String(error)).not.toContain(FILE);
});

test("extra_hosts hostname interpolation refuses project values and runtime-bound compounds", async () => {
  const f = await fixture({
    env_file: "service.env",
    extra_hosts: { "${HOST:-relay.hack}": "host-gateway" },
  });
  await f.source("service.env", `HOST=${FILE}\n`);
  const projectError: unknown = await prepareNativeProjectInput({
    ...f,
    env: { HOST: SHELL },
  }).catch((caught: unknown) => caught);
  expect(String(projectError)).toContain("variable HOST");
  expect(String(projectError)).not.toContain(SHELL);
  expect(String(projectError)).not.toContain(FILE);
  await writeFile(
    f.composeFile,
    JSON.stringify({
      services: {
        app: {
          image: "alpine",
          env_file: "service.env",
          extra_hosts: {
            "${HOST:-relay}.${COMPOSE_PROJECT_NAME}.hack": "host-gateway",
          },
        },
      },
    })
  );
  const runtimeError: unknown = await prepareNativeProjectInput(f).catch(
    (caught: unknown) => caught
  );
  expect(String(runtimeError)).toContain("COMPOSE_PROJECT_NAME");
  expect(String(runtimeError)).toContain("runtime-bound");
  expect(String(runtimeError)).not.toContain(FILE);
});

test("other public mapping keys keep their ordinary Compose semantics", async () => {
  const f = await fixture({
    env_file: "service.env",
    labels: { "${HOST:-literal-label}": "public" },
  });
  await f.source("service.env", `HOST=${FILE}\n`);
  const input = await prepareNativeProjectInput(f);
  expect(publicService(input).labels).toEqual({
    "${HOST:-literal-label}": "public",
  });
  expect(input.normalizedComposeJson).not.toContain(FILE);
});

test.each([
  "COMPOSE_PROJECT_NAME",
  "AWS_REGION",
  "MANAGED",
])("public defaults cannot freeze runtime-bound %s into a different value", async (name) => {
  const f = await fixture({
    env_file: "service.env",
    command: ["echo", `\${HOST:-localhost}/\${${name}:-fallback}`],
  });
  await f.source("service.env", `HOST=${FILE}\n`);
  await managed(f.projectDir, { app: { MANAGED } });
  const error: unknown = await prepareNativeProjectInput(f).catch(
    (caught: unknown) => caught
  );
  expect(String(error)).toContain(name);
  expect(String(error)).toContain("runtime-bound");
  expect(String(error)).not.toContain(FILE);
  expect(String(error)).not.toContain(MANAGED);
});

test("public executable defaults still refuse a defined project source beside a file binding", async () => {
  const f = await fixture({
    env_file: "service.env",
    command: ["echo", "${HOST:-localhost}/${SOURCE}"],
  });
  await f.source("service.env", `HOST=${FILE}\n`);
  await f.source(".env", `SOURCE=${DOTENV}\n`);
  const error: unknown = await prepareNativeProjectInput(f).catch(
    (caught: unknown) => caught
  );
  expect(String(error)).toContain("SOURCE");
  expect(String(error)).not.toContain(FILE);
  expect(String(error)).not.toContain(DOTENV);
});

test("env-file-local cloud values resolve without reading cloud shell values", async () => {
  const f = await fixture({ env_file: ["one.env", "two.env"] });
  await f.source(
    "one.env",
    `AWS_REGION=${FILE}\nSAME=\${AWS_REGION}\nGOOGLE_PROJECT=${DOTENV}\nCLOUDSDK_CORE_PROJECT=${FILE}\n`
  );
  await f.source(
    "two.env",
    "REGION=${AWS_REGION}\nPROJECT=${GOOGLE_PROJECT}\nCLOUD=${CLOUDSDK_CORE_PROJECT}\nAWS_REGION\n"
  );
  const env: Record<string, string> = {};
  for (const key of ["AWS_REGION", "GOOGLE_PROJECT", "CLOUDSDK_CORE_PROJECT"]) {
    Object.defineProperty(env, key, {
      enumerable: true,
      get() {
        throw new Error("cloud shell value must never be read");
      },
    });
  }
  const input = await prepareNativeProjectInput({ ...f, env });
  expect(input.shellEnvironment).toEqual({
    app: {
      AWS_REGION: FILE,
      SAME: FILE,
      GOOGLE_PROJECT: DOTENV,
      CLOUDSDK_CORE_PROJECT: FILE,
      REGION: FILE,
      PROJECT: DOTENV,
      CLOUD: FILE,
    },
  });
  expect(input.forwardedShellVariables?.app).toEqual([]);
  expect(input.normalizedComposeJson).not.toContain(FILE);
  expect(input.normalizedComposeJson).not.toContain(DOTENV);
  await f.source("one.env", "REGION=${AWS_REGION}\n");
  await expect(prepareNativeProjectInput({ ...f, env })).rejects.toThrow(
    "cannot be read from the caller's shell"
  );
});

test("dotenv cloud references use earlier local values and refuse an unavailable source", async () => {
  const f = await fixture({ environment: { REGION: "${REGION}" } });
  await f.source(".env", `AWS_REGION=${DOTENV}\nREGION=\${AWS_REGION}\n`);
  const input = await prepareNativeProjectInput({
    ...f,
    env: { AWS_REGION: SHELL },
  });
  expect(input.shellEnvironment).toEqual({ app: { REGION: DOTENV } });
  expect(input.normalizedComposeJson).not.toContain(DOTENV);
  expect(input.normalizedComposeJson).not.toContain(SHELL);
  await f.source(".env", "REGION=${AWS_REGION}\n");
  const error: unknown = await prepareNativeProjectInput({
    ...f,
    env: { AWS_REGION: SHELL },
  }).catch((caught: unknown) => caught);
  expect(String(error)).toContain("AWS_REGION cannot be read");
  expect(String(error)).not.toContain(SHELL);
});

test("NUL private inputs refuse with closed diagnostics", async () => {
  const f = await fixture({ env_file: "service.env" });
  await f.source("service.env", `TOKEN=${FILE}\0\n`);
  const error: unknown = await prepareNativeProjectInput(f).catch(
    (caught: unknown) => caught
  );
  expect(String(error)).toContain("values omitted");
  expect(String(error)).not.toContain(FILE);
});

test("documented Compose precedence includes managed globals, service values, files and interpolation sources", async () => {
  // Compose v5.6.1 / compose-go v2.16.1: project lookup > service environment
  // > current/previous env-file assignments; service environment wins finally.
  const f = await fixture({
    env_file: ["one.env", "two.env"],
    environment: {
      K: "service",
      BARE: null,
      EMPTY: "",
      FROM_CONTEXT: "${CONTEXT}",
    },
  });
  await f.source(".env", `CONTEXT=${DOTENV}\n`);
  await f.source(
    "one.env",
    `K=${FILE}\nEARLIER=${FILE}\nBARE=${FILE}\nEMPTY=${FILE}\n`
  );
  await f.source("two.env", "R=${K}\nS=${EARLIER}\nEARLIER\nT=${CONTEXT}\n");
  await managed(f.projectDir, {
    global: { CONTEXT: MANAGED },
    app: { K: MANAGED },
  });
  const input = await prepareNativeProjectInput({
    ...f,
    env: { CONTEXT: SHELL },
  });
  const final = mergeNativeShellEnvironment(input);
  expect(final.managedEnvironment.app).toEqual({
    CONTEXT: MANAGED,
    K: MANAGED,
    FROM_CONTEXT: MANAGED,
    EARLIER: FILE,
    R: MANAGED,
    S: FILE,
    T: MANAGED,
  });
  expect(publicService(input).environment.EMPTY).toBe("");
  expect(publicService(input)["x-hack-unset-environment"]).toEqual(["BARE"]);
  expect(final.forwardedShellVariables?.app).not.toContain("CONTEXT");
});

test("file value-only edits do not enter normalized identity inputs or managed fingerprints", async () => {
  const f = await fixture({
    env_file: "service.env",
    environment: { COPY: "${SOURCE}" },
  });
  const prepare = async (value: string) => {
    await f.source(".env", `SOURCE=${value}\n`);
    await f.source("service.env", `TOKEN=${value}\n`);
    return await prepareNativeProjectInput(f);
  };
  const a = await prepare(FILE);
  const b = await prepare(DOTENV);
  expect(a.normalizedComposeJson).toBe(b.normalizedComposeJson);
  expect(a.originalSha256).toBe(b.originalSha256);
  expect(a.managedEnvironment).toEqual(b.managedEnvironment);
  expect(a.shellEnvironment).not.toEqual(b.shellEnvironment);
});

test("unreferenced dotenv does not create private delivery or rewrite pure defaults", async () => {
  const f = await fixture({
    restart: "unless-stopped",
    environment: { MODE: "${NOT_SET:-safe}", LITERAL: "public" },
  });
  await f.source(".env", `UNUSED=${DOTENV}\n`);
  const input = await prepareNativeProjectInput(f);
  expect(input.shellEnvironment).toEqual({});
  expect(publicService(input).environment).toEqual({
    MODE: "${NOT_SET:-safe}",
    LITERAL: "public",
  });
});

test.each([
  { image: "example:${SOURCE:-fallback}" },
  { command: ["echo", "${SOURCE:-fallback}"] },
  { entrypoint: ["${SOURCE}"] },
  { ports: ["${SOURCE:-3000}:3000"] },
  { labels: { note: "${SOURCE}" } },
  { labels: { "x-note": "${SOURCE}" } },
  { user: "${SOURCE:-1000}" },
  { healthcheck: { test: ["CMD", "${SOURCE}"] } },
  { build: { args: { SOURCE: "${SOURCE}" } } },
])("public-field interpolation refuses before values can leave private preparation", async (service) => {
  const f = await fixture(service);
  await f.source(".env", `SOURCE=${DOTENV}\n`);
  const error: unknown = await prepareNativeProjectInput(f).catch(
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("SOURCE");
  expect(String(error)).not.toContain(DOTENV);
});

test("missing required references never echo the authored error message", async () => {
  const f = await fixture({ env_file: "service.env" });
  await f.source("service.env", `TOKEN=\${MISSING:?${FILE}}\n`);
  const error: unknown = await prepareNativeProjectInput(f).catch(
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("service.env");
  expect(String(error)).not.toContain(FILE);
});

test("possible materialized dotenv refuses; root dotenv is not an interpolation source", async () => {
  const f = await fixture({ environment: { ROOT_ONLY: "${ROOT_ONLY}" } });
  await writeFile(join(f.projectRoot, ".env"), `ROOT_ONLY=${DOTENV}\n`, {
    mode: 0o600,
  });
  const input = await prepareNativeProjectInput(f);
  expect(input.shellEnvironment?.app?.ROOT_ONLY).toBe("");
  await f.source(".env", `ROOT_ONLY=${DOTENV}\n`);
  await f.source(".env.state.json", "not trusted even if readable");
  await expect(prepareNativeProjectInput(f)).rejects.toThrow("materialized");
});

test.each([
  "COMPOSE_FILE",
  "COMPOSE_PROFILES",
  "COMPOSE_PROJECT_NAME",
  "COMPOSE_ENV_FILES",
  "HACK_ENV_SECRET_KEY",
])("dotenv cannot change project controls or forward protected %s", async (key) => {
  const f = await fixture({});
  await f.source(".env", `${key}=${DOTENV}\n`);
  const error: unknown = await prepareNativeProjectInput(f).catch(
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain(key);
  expect(String(error)).not.toContain(DOTENV);
});

test("file delivery is counted by the private service budget", async () => {
  const f = await fixture({ env_file: "service.env" });
  await f.source("service.env", `LARGE=${"x".repeat(33 * 1024)}\n`);
  const input = mergeNativeShellEnvironment(await prepareNativeProjectInput(f));
  expect(() => requireNativeShellDeliveryFits(input)).toThrow("32 KiB");
  await chmod(join(f.projectDir, "service.env"), 0o666);
  await expect(prepareNativeProjectInput(f)).rejects.toThrow(
    "not writable by others"
  );
});

test("unused extension nodes do not block aliased private environment", async () => {
  const f = await fixture(
    { environment: { TOKEN: "${SOURCE}" }, "x-env": { TOKEN: "${SOURCE}" } },
    { "x-env": { TOKEN: "${SOURCE}" } }
  );
  await f.source(".env", `SOURCE=${DOTENV}\n`);
  expect((await prepareNativeProjectInput(f)).shellEnvironment).toEqual({
    app: { TOKEN: DOTENV },
  });
});

test("a project-root alias is canonicalized without permitting source symlinks", async () => {
  const f = await fixture({ env_file: "service.env" });
  await f.source("service.env", `TOKEN=${FILE}\n`);
  const alias = join(f.projectRoot, "root-alias");
  await symlink(f.projectRoot, alias);
  const input = await prepareNativeProjectInput({
    projectRoot: alias,
    projectDir: join(alias, ".hack"),
    composeFile: join(alias, ".hack/docker-compose.yml"),
  });
  expect(input.shellEnvironment).toEqual({ app: { TOKEN: FILE } });
});

test.each([
  "AWS_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDSDK_CORE_PROJECT",
  "COMPOSE_PROJECT_NAME",
])("unreadable bare %s remains runtime-owned rather than unset", async (key) => {
  const f = await fixture({ environment: { [key]: null } });
  const input = await prepareNativeProjectInput({
    ...f,
    env: { [key]: SHELL },
  });
  expect(publicService(input).environment).toEqual({ [key]: null });
  expect(publicService(input)).not.toHaveProperty("x-hack-unset-environment");
  expect(input.shellEnvironment).toEqual({});
});

test("only delivered private values join the build disclosure guard", async () => {
  const f = await fixture({
    env_file: "service.env",
    environment: { MODE: "explicit" },
  });
  await f.source(".env", "UNUSED=production\n");
  await f.source("service.env", `MODE=production\nTOKEN=${FILE}\n`);
  const input = await prepareNativeProjectInput(f);
  expect(input.managedSecretValues).toEqual([FILE]);
});

test.each([
  { context: "..", path: "service.env" },
  { context: ".", path: "service.env" },
  { context: "../APP", path: "../app/secret.vars" },
  { context: "../STRASSE", path: "../Straße/secret.vars" },
  { context: "../café", path: "../cafe\u0301/secret.vars" },
  { context: "../app", path: "../app/nested/secret.vars" },
])("build contexts cannot overlap an optional env-file path (%s)", async ({
  context,
  path,
}) => {
  const f = await fixture(
    {},
    {
      services: {
        app: {
          image: "alpine",
          env_file: { path, required: false },
          profiles: ["inactive"],
        },
        builder: { build: { context } },
      },
    }
  );
  const error: unknown = await prepareNativeProjectInput(f).catch(
    (caught: unknown) => caught
  );
  expect(String(error)).toContain(
    "native build inputs overlap an environment source"
  );
  expect(String(error)).toContain("service builder field build");
  expect(String(error)).not.toContain(FILE);
});

test.each([
  "../.hack/service.env",
  "../.hack/service.env.dockerignore",
])("build definition inputs outside the context cannot read env-file %s", async (path) => {
  const f = await fixture(
    {},
    {
      services: {
        app: {
          image: "alpine",
          env_file: {
            path: path.endsWith(".dockerignore")
              ? "service.env.dockerignore"
              : "service.env",
            required: false,
          },
        },
        builder: {
          build: { context: "../app", dockerfile: "../.hack/service.env" },
        },
      },
    }
  );
  const error: unknown = await prepareNativeProjectInput(f).catch(
    (caught: unknown) => caught
  );
  expect(String(error)).toContain(
    "native build inputs overlap an environment source"
  );
});

test("a selected dotenv cannot enter the raw build context even with no delivered key", async () => {
  const f = await fixture({}, { services: { builder: { build: ".." } } });
  await f.source(".env", `# ${DOTENV}\n`);
  const error: unknown = await prepareNativeProjectInput(f).catch(
    (caught: unknown) => caught
  );
  expect(String(error)).toContain("overlap an environment source");
  expect(String(error)).not.toContain(DOTENV);
});

test("env-file sources stay private with disjoint native build inputs", async () => {
  const f = await fixture(
    {},
    {
      services: {
        app: { image: "alpine", env_file: "service.env" },
        builder: { build: { context: "../app", dockerfile: "Dockerfile" } },
      },
    }
  );
  await f.source("service.env", `TOKEN=${FILE}\n`);
  await f.source(".env", `UNUSED=${DOTENV}\n`);
  const input = await prepareNativeProjectInput(f);
  expect(input.shellEnvironment).toEqual({ app: { TOKEN: FILE } });
  expect(publicService(input).environment).toEqual({ TOKEN: null });
  expect(input.normalizedComposeJson).not.toContain(FILE);
  expect(input.normalizedComposeJson).not.toContain(DOTENV);
});

test("source-free builds and selected-service exec retain their existing behavior", async () => {
  const plain = await fixture({}, { services: { builder: { build: ".." } } });
  expect((await prepareNativeProjectInput(plain)).shellEnvironment).toEqual({});
  const f = await fixture(
    {},
    {
      services: {
        app: { image: "alpine", env_file: "service.env" },
        builder: { build: ".." },
      },
    }
  );
  await f.source("service.env", `TOKEN=${FILE}\n`);
  const input = await prepareNativeProjectInput({
    ...f,
    selectedServices: ["app"],
  });
  expect(input.shellEnvironment).toEqual({ app: { TOKEN: FILE } });
  expect(input.normalizedComposeJson).not.toContain(FILE);
});

test("authored public runtime metadata literals survive while file/shell copies stay refused", async () => {
  const f = await fixture({
    environment: { HACK_SERVICE_URL: "author-owned" },
  });
  const input = await prepareNativeProjectInput(f);
  expect(publicService(input).environment.HACK_SERVICE_URL).toBe(
    "author-owned"
  );
  expect(input.shellEnvironment).toEqual({});
  await writeFile(
    f.composeFile,
    JSON.stringify({
      services: {
        app: {
          image: "alpine",
          environment: { HACK_SERVICE_URL: "${SOURCE}" },
        },
      },
    })
  );
  await expect(
    prepareNativeProjectInput({ ...f, env: { SOURCE: SHELL } })
  ).rejects.toThrow("reserved destination");
  await writeFile(
    f.composeFile,
    JSON.stringify({
      services: {
        app: { image: "alpine", environment: { HACK_ENV_SECRET_KEY: FILE } },
      },
    })
  );
  const error: unknown = await prepareNativeProjectInput(f).catch(
    (caught: unknown) => caught
  );
  expect(String(error)).toContain("key material");
  expect(String(error)).not.toContain(FILE);
});

test("inactive service files are not read, but selected profiles require them", async () => {
  const f = await fixture(
    {},
    {
      services: {
        app: { image: "alpine" },
        worker: {
          image: "alpine",
          profiles: ["worker"],
          env_file: "missing.env",
        },
      },
    }
  );
  const inactive = await prepareNativeProjectInput(f);
  expect(inactive.shellEnvironment).toEqual({});
  expect(() =>
    selectActiveNativeProjectInput({
      input: inactive,
      reviewedPlan: {
        services: { app: { active: true }, worker: { active: true } },
      },
    })
  ).toThrow("env_file activation differs");
  expect(() =>
    selectActiveNativeProjectInput({
      input: inactive,
      reviewedPlan: {
        services: { app: { active: true }, worker: { active: false } },
      },
    })
  ).not.toThrow();
  await expect(
    prepareNativeProjectInput({ ...f, profiles: ["worker"] })
  ).rejects.toThrow("required source is missing");
  await f.source("missing.env", `TOKEN=${FILE}\n`);
  await chmod(join(f.projectDir, "missing.env"), 0o666);
  expect((await prepareNativeProjectInput(f)).shellEnvironment).toEqual({});
});

test("materialized dotenv identity aliases are refused before source reading", async () => {
  const f = await fixture({ env_file: "alias.env" });
  await f.source(".env", `TOKEN=${DOTENV}\n`);
  await f.source(".env.state.json", "{}\n");
  await link(join(f.projectDir, ".env"), join(f.projectDir, "alias.env"));
  await expect(prepareNativeProjectInput(f)).rejects.toThrow("materialized");
});

test("exact credential-adapter mounts remain eligible with HOME in the shell", async () => {
  const aws = await fixture({
    volumes: ["${HOME}/.aws:/root/.aws:ro"],
    environment: { AWS_REGION: null },
  });
  const awsInput = mergeNativeShellEnvironment(
    await prepareNativeProjectInput({ ...aws, env: { HOME: SHELL } })
  );
  const adapted = await adaptNativeAwsEnvironment({
    input: awsInput,
    profile: "fixture",
    region: "us-east-1",
    homeDirectory: aws.projectRoot,
    exportSource: async () => ({
      credentials: {
        Version: 1,
        AccessKeyId: "synthetic-access",
        SecretAccessKey: "synthetic-secret",
        SessionToken: "synthetic-session",
        Expiration: new Date(Date.now() + 3_600_000).toISOString(),
      },
      region: "us-east-1",
    }),
  });
  expect(
    JSON.parse(adapted.input.normalizedComposeJson).services.app
  ).not.toHaveProperty("x-hack-unset-environment");
  const gcloud = await fixture({
    volumes: [
      "${HOME}/.config/gcloud/application_default_credentials.json:/tmp/adc.json:ro",
    ],
    environment: { GOOGLE_APPLICATION_CREDENTIALS: "/tmp/adc.json" },
  });
  const gcloudInput = await prepareNativeProjectInput({
    ...gcloud,
    env: { HOME: SHELL },
  });
  const google = await adaptNativeGcloudEnvironment({
    input: gcloudInput,
    mode: "file",
    deliver: false,
    homeDirectory: gcloud.projectRoot,
  });
  expect(
    JSON.parse(google.input.normalizedComposeJson).services.app.volumes ?? []
  ).toEqual([]);
});
