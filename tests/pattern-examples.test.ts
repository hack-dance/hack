import { afterEach, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { YAML } from "bun";

import {
  PATTERN_CATALOGUE,
  type PatternCard,
} from "../src/agents/pattern-catalogue.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";
import { resolveDependencyCacheOverride } from "../src/lib/dependency-cache.ts";
import { isRecord } from "../src/lib/guards.ts";
import {
  findProjectContextAtRoot,
  readProjectConfig,
} from "../src/lib/project.ts";
import { resolveProjectEnvConfig } from "../src/lib/project-env-config.ts";
import { renderProjectConfigSchemaJson } from "../src/templates.ts";
import { ALL_SCENARIOS } from "./e2e/run.ts";
import { E2E_DURATION_HINTS_SECONDS } from "./e2e/shard.ts";
import {
  extractHackInvocations,
  findGuidanceCommandIssues,
} from "./helpers/cli-guidance-commands.ts";
import { validateJsonSchemaSubset } from "./helpers/json-schema-subset.ts";
import {
  e2eRegistrationIssues,
  exampleReferenceIssues,
  overlayIssues,
  readmeServiceIssues,
  toolchainServiceIssues,
} from "./helpers/pattern-fixtures.ts";
import { bannedRecipeFindings } from "./helpers/pattern-recipes.ts";

/**
 * Static validation of the HACK-P01/P02/P07 example fixtures. Nothing here
 * starts containers or contacts Docker; the dependency-cache and env
 * resolution run against temporary copies so generated `.hack/.internal`
 * files never land in the repository. The Docker-tier scenarios that start
 * these fixtures live in tests/e2e/scenarios/pattern-*.ts.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const P01_DIR = "examples/patterns/p01-dependency-bootstrap";
const P02_DIR = "examples/patterns/p02-portable-toolchain";
const P07_DIR = "examples/patterns/p07-capability-overlays";
const EXAMPLE_CARDS = ["HACK-P01", "HACK-P02", "HACK-P07"] as const;

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function card(id: string): PatternCard {
  const found = PATTERN_CATALOGUE.find((entry) => entry.id === id);
  if (!found) {
    throw new Error("missing card");
  }
  return found;
}

function exampleDir(id: string): string {
  const example = card(id).example;
  if (example === null) {
    throw new Error("card has no example");
  }
  return join(REPO_ROOT, example);
}

async function readText(dir: string, file: string): Promise<string> {
  return await Bun.file(join(dir, file)).text();
}

async function readCompose(dir: string): Promise<Record<string, unknown>> {
  const parsed: unknown = YAML.parse(
    await readText(dir, ".hack/docker-compose.yml")
  );
  if (!isRecord(parsed)) {
    throw new Error("compose root must be a mapping");
  }
  return parsed;
}

async function readConfigJson(dir: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(
    await readText(dir, ".hack/hack.config.json")
  );
  if (!isRecord(parsed)) {
    throw new Error("config root must be an object");
  }
  return parsed;
}

function projectSchema(): unknown {
  return JSON.parse(renderProjectConfigSchemaJson());
}

/** Structured clone so mutations never touch the parsed fixture. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

function service(
  compose: Record<string, unknown>,
  name: string
): Record<string, unknown> {
  const services = compose.services;
  const entry = isRecord(services) ? services[name] : undefined;
  if (!isRecord(entry)) {
    throw new Error("missing service");
  }
  return entry;
}

async function copyExample(id: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hack-pattern-example-"));
  roots.push(root);
  const target = join(root, "project");
  await cp(exampleDir(id), target, { recursive: true });
  return target;
}

async function resolveP01Cache(opts: {
  readonly projectRoot: string;
  readonly compose: unknown;
}) {
  const projectDir = join(opts.projectRoot, ".hack");
  const composeFile = join(projectDir, "docker-compose.yml");
  await Bun.write(composeFile, YAML.stringify(opts.compose));
  return await resolveDependencyCacheOverride({
    projectRoot: opts.projectRoot,
    projectDir,
    composeFile,
    projectName: "pattern-p01",
  });
}

test("P01, P02 and P07 reference their example fixtures and every fixture belongs to a card", async () => {
  expect(card("HACK-P01").example).toBe(P01_DIR);
  expect(card("HACK-P02").example).toBe(P02_DIR);
  expect(card("HACK-P07").example).toBe(P07_DIR);
  expect(
    await exampleReferenceIssues({
      repoRoot: REPO_ROOT,
      cards: PATTERN_CATALOGUE,
    })
  ).toEqual([]);
});

test("negative control: a broken, shared or escaping example reference fails", async () => {
  const withExample = (id: string, example: string | null) =>
    PATTERN_CATALOGUE.map((entry) =>
      entry.id === id ? { ...entry, example } : entry
    );
  expect(
    await exampleReferenceIssues({
      repoRoot: REPO_ROOT,
      cards: withExample("HACK-P01", "examples/patterns/missing"),
    })
  ).toEqual([
    "HACK-P01: missing-README.md",
    "HACK-P01: missing-.hack/hack.config.json",
    "HACK-P01: missing-.hack/docker-compose.yml",
    "unreferenced-example-directory",
  ]);
  expect(
    await exampleReferenceIssues({
      repoRoot: REPO_ROOT,
      cards: withExample("HACK-P03", P01_DIR),
    })
  ).toEqual(["HACK-P03: example-shared-with-HACK-P01"]);
  expect(
    await exampleReferenceIssues({
      repoRoot: REPO_ROOT,
      cards: withExample("HACK-P02", "examples/basic"),
    })
  ).toEqual([
    "HACK-P02: example-outside-patterns-dir",
    "unreferenced-example-directory",
  ]);
  expect(
    await exampleReferenceIssues({
      repoRoot: REPO_ROOT,
      cards: withExample("HACK-P02", "examples/patterns/../basic"),
    })
  ).toEqual([
    "HACK-P02: example-outside-patterns-dir",
    "unreferenced-example-directory",
  ]);
});

test("each fixture's hack.config.json validates against the project schema and parser", async () => {
  for (const id of EXAMPLE_CARDS) {
    const dir = exampleDir(id);
    const config = await readConfigJson(dir);
    expect(
      validateJsonSchemaSubset({ schema: projectSchema(), value: config }),
      id
    ).toEqual([]);

    const context = await findProjectContextAtRoot({ projectRoot: dir });
    expect(context?.projectDirName, id).toBe(".hack");
    if (!context) {
      throw new Error("fixture is not a legacy project root");
    }
    const parsed = await readProjectConfig(context);
    expect(parsed.parseError, id).toBeUndefined();
    expect(parsed.name, id).toBe(config.name as string);
    expect((await readCompose(dir)).name, id).toBe(config.name);
  }
});

test("negative control: breaking a fixture config fails schema or parser validation", async () => {
  const schema = projectSchema();
  const p01 = await readConfigJson(exampleDir("HACK-P01"));

  const { dev_host: _removedHost, ...withoutHost } = clone(p01);
  expect(validateJsonSchemaSubset({ schema, value: withoutHost })).toEqual([
    { pointer: "/dev_host", code: "required" },
  ]);

  const badBackend = clone(p01);
  badBackend.logs = { follow_backend: "syslog" };
  expect(validateJsonSchemaSubset({ schema, value: badBackend })).toEqual([
    { pointer: "/logs/follow_backend", code: "enum" },
  ]);

  const badName = clone(p01);
  badName.name = 42;
  expect(validateJsonSchemaSubset({ schema, value: badName })).toEqual([
    { pointer: "/name", code: "type" },
  ]);

  // The validator refuses keywords it cannot evaluate instead of passing.
  expect(
    validateJsonSchemaSubset({
      schema: { type: "string", pattern: "^x$" },
      value: "x",
    })
  ).toEqual([{ pointer: "", code: "unsupported-keyword" }]);

  // On disk: a corrupted copy is reported by the runtime parser.
  const copy = await copyExample("HACK-P02");
  await Bun.write(join(copy, ".hack/hack.config.json"), "{ not json");
  const context = await findProjectContextAtRoot({ projectRoot: copy });
  if (!context) {
    throw new Error("copied fixture is not a legacy project root");
  }
  expect((await readProjectConfig(context)).parseError).toBeDefined();
});

test("P01 compose passes the locked-v1 dependency cache contract", async () => {
  const projectRoot = await copyExample("HACK-P01");
  const compose = await readCompose(projectRoot);
  const resolution = await resolveP01Cache({ projectRoot, compose });

  expect(resolution.progressServices).toEqual(["install"]);
  expect(resolution.sharingDisabledReason).toBeUndefined();
  expect(resolution.fingerprint).toMatch(/^[a-f0-9]{16}$/);
  expect(
    resolution.volumes.map((volume) => ({
      logicalName: volume.logicalName,
      services: volume.services,
    }))
  ).toEqual([{ logicalName: "dependencies", services: ["install"] }]);
  expect(
    resolution.inputs.map((input) => relative(projectRoot, input))
  ).toEqual([
    "bun.lock",
    "package.json",
    "packages/greeting/index.js",
    "packages/greeting/package.json",
  ]);

  // Generation is a separate always-run step with its own output volume, and
  // the application waits for both one-shot steps.
  const generate = service(compose, "generate");
  const app = service(compose, "app");
  expect(generate.labels).toBeUndefined();
  expect(generate.volumes).toContain("generated:/generated");
  expect(service(compose, "install").volumes).not.toContain(
    "generated:/generated"
  );
  expect(app.depends_on).toEqual({
    install: { condition: "service_completed_successfully" },
    generate: { condition: "service_completed_successfully" },
  });
  expect(app.volumes).toContain("generated:/generated:ro");
  expect(app.healthcheck).toBeDefined();
});

test("negative control: breaking the P01 compose contract is refused", async () => {
  const projectRoot = await copyExample("HACK-P01");
  const original = await readCompose(projectRoot);
  const mutations: Readonly<
    Record<string, (compose: Record<string, unknown>) => void>
  > = {
    "writable consumer mount": (compose) => {
      service(compose, "app").volumes = [
        "..:/app",
        "dependencies:/app/node_modules",
        "generated:/generated:ro",
      ];
    },
    "missing completion gate": (compose) => {
      service(compose, "generate").depends_on = undefined;
    },
    "initializer environment": (compose) => {
      service(compose, "install").environment = { NODE_ENV: "production" };
    },
    "unresolved installer image": (compose) => {
      service(compose, "install").image = "oven/bun:${BUN_TAG}";
    },
    "string initializer command": (compose) => {
      service(compose, "install").command = "bun install --frozen-lockfile";
    },
    "named cache volume": (compose) => {
      compose.volumes = {
        dependencies: { name: "shared-dependencies" },
        generated: {},
      };
    },
  };
  // Baseline: the unmodified copy resolves, so each refusal is the mutation's.
  expect(
    (await resolveP01Cache({ projectRoot, compose: original })).progressServices
  ).toEqual(["install"]);
  for (const [name, mutate] of Object.entries(mutations)) {
    const compose = clone(original);
    mutate(compose);
    let message = "";
    try {
      await resolveP01Cache({ projectRoot, compose });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : "non-error";
    }
    expect(message, name).toMatch(/dependency cache/i);
  }
});

test("P02 compose is a profiled, pinned, bounded one-shot toolchain", async () => {
  const compose = await readCompose(exampleDir("HACK-P02"));
  expect(toolchainServiceIssues({ compose, service: "toolchain" })).toEqual([]);
});

test("negative control: breaking the P02 toolchain contract fails", async () => {
  const original = await readCompose(exampleDir("HACK-P02"));
  const check = (mutate: (compose: Record<string, unknown>) => void) => {
    const compose = clone(original);
    mutate(compose);
    return toolchainServiceIssues({ compose, service: "toolchain" });
  };
  const addMount = (mount: string) => (compose: Record<string, unknown>) => {
    const toolchain = service(compose, "toolchain");
    toolchain.volumes = [...(toolchain.volumes as unknown[]), mount];
  };
  expect(check(addMount("/var/run/docker.sock:/var/run/docker.sock"))).toEqual([
    "forbidden-mount-docker-socket",
  ]);
  expect(check(addMount("~/.config:/root/.config"))).toEqual([
    "forbidden-mount-home",
  ]);
  expect(check(addMount("$SSH_AUTH_SOCK:/ssh-agent"))).toEqual([
    "forbidden-mount-ssh",
  ]);
  expect(check(addMount("/opt/cache:/cache/other"))).toEqual([
    "cache-not-named-volume",
  ]);
  expect(
    check((compose) => {
      service(compose, "toolchain").profiles = undefined;
    })
  ).toEqual(["always-on-service-toolchain"]);
  expect(
    check((compose) => {
      service(compose, "toolchain").image = "oven/bun:latest";
    })
  ).toEqual(["image-not-digest-pinned"]);
  expect(
    check((compose) => {
      const toolchain = service(compose, "toolchain");
      toolchain.cpus = undefined;
      toolchain.mem_limit = undefined;
    })
  ).toEqual(["missing-cpu-bound", "missing-memory-bound"]);
  expect(
    check((compose) => {
      service(compose, "toolchain").env_file = [".env"];
    })
  ).toEqual(["env-file"]);
  expect(
    check((compose) => {
      (compose.services as Record<string, unknown>).app = {
        image: "nginx",
      };
    })
  ).toEqual(["always-on-service-app"]);
});

test("every hack command in the fixture READMEs resolves in CLI_SPEC and names real services", async () => {
  for (const id of EXAMPLE_CARDS) {
    const dir = exampleDir(id);
    const readme = await readText(dir, "README.md");
    const compose = await readCompose(dir);
    const invocations = extractHackInvocations(readme);
    expect(invocations.length, id).toBeGreaterThan(0);
    expect(
      findGuidanceCommandIssues({ cli: CLI_SPEC, rendered: readme }),
      id
    ).toEqual([]);
    expect(readmeServiceIssues({ cli: CLI_SPEC, readme, compose }), id).toEqual(
      []
    );
    // The fixture exercises each command family its card names.
    for (const command of card(id).supportedCommands) {
      const prefix = command.split(" <")[0] ?? command;
      expect(
        invocations.some((invocation) => invocation.startsWith(prefix)),
        `${id}: ${prefix}`
      ).toBe(true);
    }
    expect(bannedRecipeFindings(readme), id).toEqual([]);
    expect(
      bannedRecipeFindings(await readText(dir, ".hack/docker-compose.yml")),
      id
    ).toEqual([]);
  }
});

test("negative control: an invalid README command or service reference fails", async () => {
  const dir = exampleDir("HACK-P02");
  const readme = await readText(dir, "README.md");
  const compose = await readCompose(dir);
  const withLine = (line: string) => `${readme}\n\`${line}\`\n`;

  expect(
    findGuidanceCommandIssues({
      cli: CLI_SPEC,
      rendered: withLine(
        "hack run --profile toolchain --fast toolchain -- bun test"
      ),
    }).length
  ).toBe(1);
  expect(
    readmeServiceIssues({
      cli: CLI_SPEC,
      compose,
      readme: withLine("hack run --profile other toolchain -- bun test"),
    })
  ).toEqual(["run-undeclared-profile", "run-missing-profile"]);
  expect(
    readmeServiceIssues({
      cli: CLI_SPEC,
      compose,
      readme: withLine("hack run toolchain -- bun test"),
    })
  ).toEqual(["run-missing-profile"]);
  expect(
    readmeServiceIssues({
      cli: CLI_SPEC,
      compose,
      readme: withLine("hack logs --no-follow --tail 100 nope"),
    })
  ).toEqual(["logs-unknown-service"]);
  expect(
    bannedRecipeFindings(`${readme}\n    command: sleep infinity\n`)
  ).toEqual(["placeholder-liveness-sleep"]);
});

async function readEnvFile(dir: string, overlay: string): Promise<unknown> {
  return YAML.parse(await readText(dir, `.hack/hack.env.${overlay}.yaml`));
}

async function readP07Overlays(dir: string) {
  return {
    base: await readEnvFile(dir, "default"),
    overlays: {
      laptop: await readEnvFile(dir, "laptop"),
      runner: await readEnvFile(dir, "runner"),
    },
  };
}

test("P07 overlays express only capability differences over one shared topology", async () => {
  const dir = exampleDir("HACK-P07");
  expect(overlayIssues(await readP07Overlays(dir))).toEqual([]);

  // The real resolver sees the same split: shared values from the base file,
  // capabilities only from the selected overlay.
  const projectRoot = await copyExample("HACK-P07");
  const resolve = async (envName: string | null) => {
    const resolved = await resolveProjectEnvConfig({
      projectRoot,
      projectDir: join(projectRoot, ".hack"),
      envName,
      serviceNames: ["api", "upstream"],
    });
    if (!resolved) {
      throw new Error("missing resolved env");
    }
    return resolved.serviceEnv.api ?? {};
  };
  const shared = {
    UPSTREAM_URL: "http://upstream:4000",
    UPSTREAM_TIMEOUT_MS: "3000",
  };
  expect(await resolve("laptop")).toEqual({
    ...shared,
    AUTH_MODE: "browser-session",
    BROWSER_SIGN_IN: "allowed",
    HELPER_MODE: "host-helper",
  });
  expect(await resolve("runner")).toEqual({
    ...shared,
    AUTH_MODE: "machine-identity",
    BROWSER_SIGN_IN: "disabled",
    HELPER_MODE: "none",
  });
  // Base layers alone carry no auth capability, so the app refuses to start.
  expect(await resolve(null)).toEqual(shared);

  // Both overlays start the same services with the same commands.
  const compose = await readCompose(dir);
  expect(Object.keys(compose.services as object).sort()).toEqual([
    "api",
    "upstream",
  ]);
  expect(service(compose, "api").depends_on).toEqual({
    upstream: { condition: "service_healthy" },
  });
  expect(service(compose, "api").environment).toBeUndefined();
});

test("negative control: an overlay that changes topology or drifts is refused", async () => {
  const { base, overlays } = await readP07Overlays(exampleDir("HACK-P07"));
  const globals = (document: unknown): Record<string, unknown> => {
    const values = isRecord(document) ? document.values : undefined;
    const global = isRecord(values) ? values.global : undefined;
    if (!isRecord(global)) {
      throw new Error("overlay without global values");
    }
    return global;
  };
  const runner = (opts: {
    readonly environment?: string;
    readonly global: Record<string, unknown>;
  }) => ({
    base,
    overlays: {
      laptop: overlays.laptop,
      runner: {
        version: 1,
        environment: opts.environment ?? "runner",
        secretsprovider: "project_key",
        values: { global: opts.global },
      },
    },
  });
  const runnerGlobal = globals(overlays.runner);
  // Baseline: rebuilding the runner overlay unchanged passes.
  expect(overlayIssues(runner({ global: { ...runnerGlobal } }))).toEqual([]);
  expect(
    overlayIssues(
      runner({
        global: { ...runnerGlobal, UPSTREAM_URL: "http://localhost:4000" },
      })
    )
  ).toEqual(["runner: overrides-shared-key", "overlay-key-sets-differ"]);
  const { BROWSER_SIGN_IN: _dropped, ...withoutSignIn } = runnerGlobal;
  expect(overlayIssues(runner({ global: withoutSignIn }))).toEqual([
    "overlay-key-sets-differ",
  ]);
  expect(
    overlayIssues(
      runner({
        global: { ...runnerGlobal, AUTH_MODE: { secure: "v1:ciphertext" } },
      })
    )
  ).toEqual(["runner: non-plaintext-capability"]);
  expect(
    overlayIssues(
      runner({ environment: "laptop", global: { ...runnerGlobal } })
    )
  ).toEqual(["runner: environment-mismatch"]);
  expect(
    overlayIssues({ base, overlays: { laptop: overlays.laptop } })
  ).toEqual(["fewer-than-two-overlays"]);
  expect(overlayIssues({ base: {}, overlays })).toEqual([
    "base-without-shared-values",
  ]);
});

test("each example card names a registered, hinted Docker-tier E2E scenario", () => {
  expect(
    EXAMPLE_CARDS.map((id) => card(id).e2eScenario).every(
      (name) => typeof name === "string"
    )
  ).toBe(true);
  expect(
    e2eRegistrationIssues({
      cards: PATTERN_CATALOGUE,
      scenarios: ALL_SCENARIOS,
      hints: E2E_DURATION_HINTS_SECONDS,
    })
  ).toEqual([]);
});

test("negative control: an unregistered, local-tier or unhinted scenario is reported", () => {
  const withScenario = (id: string, e2eScenario: string | null) =>
    PATTERN_CATALOGUE.map((entry) =>
      entry.id === id ? { ...entry, e2eScenario } : entry
    );
  const check = (opts: {
    readonly cards?: readonly PatternCard[];
    readonly scenarios?: readonly { name: string; tier: string }[];
    readonly hints?: Readonly<Record<string, number>>;
  }) =>
    e2eRegistrationIssues({
      cards: opts.cards ?? PATTERN_CATALOGUE,
      scenarios: opts.scenarios ?? ALL_SCENARIOS,
      hints: opts.hints ?? E2E_DURATION_HINTS_SECONDS,
    });
  expect(
    check({ cards: withScenario("HACK-P01", "missing-scenario") })
  ).toEqual(["HACK-P01: scenario-not-registered"]);
  expect(check({ cards: withScenario("HACK-P02", null) })).toEqual([
    "HACK-P02: scenario-not-registered",
  ]);
  expect(check({ cards: withScenario("HACK-P03", "init") })).toEqual([
    "HACK-P03: scenario-without-example",
  ]);
  const p07 = card("HACK-P07").e2eScenario ?? "";
  expect(
    check({
      scenarios: ALL_SCENARIOS.map((entry) =>
        entry.name === p07 ? { ...entry, tier: "local" } : entry
      ),
    })
  ).toEqual(["HACK-P07: scenario-not-docker-tier"]);
  const { [p07]: _removed, ...unhinted } = E2E_DURATION_HINTS_SECONDS;
  expect(check({ hints: unhinted })).toEqual([
    "HACK-P07: scenario-without-duration-hint",
  ]);
});
