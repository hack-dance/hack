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
import { renderProjectConfigSchemaJson } from "../src/templates.ts";
import {
  extractHackInvocations,
  findGuidanceCommandIssues,
} from "./helpers/cli-guidance-commands.ts";
import { validateJsonSchemaSubset } from "./helpers/json-schema-subset.ts";
import {
  exampleReferenceIssues,
  readmeServiceIssues,
  toolchainServiceIssues,
} from "./helpers/pattern-fixtures.ts";
import { bannedRecipeFindings } from "./helpers/pattern-recipes.ts";

/**
 * Static validation of the HACK-P01/P02 example fixtures. Nothing here starts
 * containers or contacts Docker; the dependency-cache resolution runs against
 * a temporary copy so generated `.hack/.internal` files never land in the
 * repository.
 */

const REPO_ROOT = join(import.meta.dir, "..");
const P01_DIR = "examples/patterns/p01-dependency-bootstrap";
const P02_DIR = "examples/patterns/p02-portable-toolchain";

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

test("P01 and P02 reference their example fixtures and every fixture belongs to a card", async () => {
  expect(card("HACK-P01").example).toBe(P01_DIR);
  expect(card("HACK-P02").example).toBe(P02_DIR);
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
  for (const id of ["HACK-P01", "HACK-P02"]) {
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
  for (const id of ["HACK-P01", "HACK-P02"]) {
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
