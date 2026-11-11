import { afterEach, expect, test } from "bun:test";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { YAML } from "bun";

import {
  docIncludeIssues,
  parseDocIncludes,
} from "../scripts/lib/doc-includes.ts";
import { isRecord } from "../src/lib/guards.ts";
import {
  findProjectContextAtRoot,
  readProjectConfig,
} from "../src/lib/project.ts";
import { renderProjectConfigSchemaJson } from "../src/templates.ts";
import { validateJsonSchemaSubset } from "./helpers/json-schema-subset.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";
import {
  composeIssues,
  depsPatternIssues,
  envFileIssues,
  lifecycleScriptPaths,
  listRecipeExamples,
  lockfileIssues,
  pinnedDependencies,
} from "./helpers/recipe-examples.ts";

/**
 * The recipe pages (docs/recipes) show checked-in example projects
 * (examples/recipes, examples/configs). These tests keep the two from going
 * stale: each project's config passes the schema and the runtime parser, its
 * Compose file and env files follow the documented patterns, the current
 * source CLI resolves its env, and every code block marked as an include
 * equals its file. Nothing here starts containers or contacts a Docker
 * engine. Set HACK_TEST_COMPOSE_CONFIG=1 to also run `docker compose config`
 * on every example (no engine needed; CI does this on a docker-e2e shard).
 */

const REPO_ROOT = join(import.meta.dir, "..");
const RECIPES_DIR = join(REPO_ROOT, "docs/recipes");
const CLI_TIMEOUT_MS = 30_000;
const composeConfigTest =
  process.env.HACK_TEST_COMPOSE_CONFIG === "1" ? test : test.skip;

/** Examples whose Node or Bun packages are installed on the host by design. */
const HOST_INSTALL_EXAMPLES = new Set(["examples/configs/host-dev-server"]);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await Bun.file(path).text());
}

async function readYaml(path: string): Promise<unknown> {
  return YAML.parse(await Bun.file(path).text());
}

async function readRecord(path: string): Promise<Record<string, unknown>> {
  const parsed = path.endsWith(".json")
    ? await readJson(path)
    : await readYaml(path);
  if (!isRecord(parsed)) {
    throw new Error("expected a mapping");
  }
  return parsed;
}

async function readRepoFile(path: string): Promise<string | null> {
  const file = Bun.file(join(REPO_ROOT, path));
  return (await file.exists()) ? await file.text() : null;
}

async function envFileNames(dir: string): Promise<string[]> {
  return (await readdir(join(REPO_ROOT, dir, ".hack")))
    .filter((name) => name.startsWith("hack.env."))
    .sort();
}

/** package.json files of a project, workspace packages included. */
async function packageJsonPaths(dir: string): Promise<string[]> {
  const glob = new Bun.Glob("**/package.json");
  const paths: string[] = [];
  for await (const path of glob.scan({ cwd: join(REPO_ROOT, dir) })) {
    if (!path.includes("node_modules")) {
      paths.push(join(REPO_ROOT, dir, path));
    }
  }
  return paths;
}

async function recipePages(): Promise<string[]> {
  return (await readdir(RECIPES_DIR))
    .filter((name) => name.endsWith(".md"))
    .map((name) => join(RECIPES_DIR, name));
}

async function copyExample(dir: string): Promise<{
  readonly root: string;
  readonly project: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "hack-recipe-example-"));
  roots.push(root);
  const project = join(root, "project");
  await cp(join(REPO_ROOT, dir), project, { recursive: true });
  return { root, project };
}

async function runSourceCli(opts: {
  readonly root: string;
  readonly cwd: string;
  readonly args: readonly string[];
}): Promise<{ exitCode: number; stdout: string }> {
  const child = Bun.spawn({
    cmd: [process.execPath, join(REPO_ROOT, "index.ts"), ...opts.args],
    cwd: opts.cwd,
    env: privateCliEnv({
      root: opts.root,
      env: { HACK_NO_INTERACTIVE: "1", NO_COLOR: "1" },
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: CLI_TIMEOUT_MS,
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return { exitCode, stdout };
}

const examples = await listRecipeExamples(REPO_ROOT);

test("the example roots contain the documented projects", () => {
  expect(examples).toEqual([
    "examples/configs/api-worker-queue",
    "examples/configs/host-dev-server",
    "examples/configs/monorepo",
    "examples/configs/python-postgres",
    "examples/configs/static-site",
    "examples/configs/web-postgres",
    "examples/recipes/cli-login",
    "examples/recipes/deps-service",
    "examples/recipes/environments",
    "examples/recipes/migrations",
    "examples/recipes/remote-database",
    "examples/recipes/tunnel",
  ]);
});

test("each example config passes the project schema and the runtime parser", async () => {
  const schema: unknown = JSON.parse(renderProjectConfigSchemaJson());
  for (const dir of examples) {
    const config = await readRecord(
      join(REPO_ROOT, dir, ".hack/hack.config.json")
    );
    expect(validateJsonSchemaSubset({ schema, value: config }), dir).toEqual(
      []
    );
    expect(config.dev_host, dir).toBe(`${String(config.name)}.hack.local`);
    const context = await findProjectContextAtRoot({
      projectRoot: join(REPO_ROOT, dir),
    });
    if (!context) {
      throw new Error(`${dir} is not a project root`);
    }
    const parsed = await readProjectConfig(context);
    expect(parsed.parseError, dir).toBeUndefined();
    expect(parsed.name, dir).toBe(String(config.name));
    for (const script of lifecycleScriptPaths(config)) {
      expect(
        await Bun.file(join(REPO_ROOT, dir, script)).exists(),
        script
      ).toBe(true);
    }
  }
});

test("each example Compose file follows the routing, image and deps rules", async () => {
  for (const dir of examples) {
    const config = await readRecord(
      join(REPO_ROOT, dir, ".hack/hack.config.json")
    );
    const compose = await readRecord(
      join(REPO_ROOT, dir, ".hack/docker-compose.yml")
    );
    expect(
      composeIssues({
        compose,
        configName: String(config.name),
        devHost: String(config.dev_host),
      }),
      dir
    ).toEqual([]);

    const pinned: string[] = [];
    for (const path of await packageJsonPaths(dir)) {
      pinned.push(...pinnedDependencies(await readJson(path)));
    }
    expect(
      lockfileIssues({
        pinned,
        lockfile: await readRepoFile(`${dir}/bun.lock`),
      }),
      dir
    ).toEqual([]);
    if (pinned.length > 0 && !HOST_INSTALL_EXAMPLES.has(dir)) {
      expect(depsPatternIssues(compose), dir).toEqual([]);
    }
  }
  // The Python example follows the same pattern with a virtual environment.
  expect(
    depsPatternIssues(
      await readRecord(
        join(
          REPO_ROOT,
          "examples/configs/python-postgres/.hack/docker-compose.yml"
        )
      )
    )
  ).toEqual([]);
});

test("each example env file is a committed, secret-free overlay with known scopes", async () => {
  for (const dir of examples) {
    const compose = await readRecord(
      join(REPO_ROOT, dir, ".hack/docker-compose.yml")
    );
    const serviceNames = isRecord(compose.services)
      ? Object.keys(compose.services)
      : [];
    const names = await envFileNames(dir);
    expect(names, dir).toContain("hack.env.default.yaml");
    for (const fileName of names) {
      expect(
        envFileIssues({
          fileName,
          document: await readYaml(join(REPO_ROOT, dir, ".hack", fileName)),
          serviceNames,
        }),
        `${dir}/${fileName}`
      ).toEqual([]);
    }
  }
});

test("the current source CLI resolves every example's env overlays", async () => {
  const checkExample = async (dir: string): Promise<void> => {
    const { root, project } = await copyExample(dir);
    const overlays = (await envFileNames(dir)).map((name) =>
      name === "hack.env.default.yaml"
        ? "base"
        : name.replace(/^hack\.env\./, "").replace(/\.yaml$/, "")
    );
    for (const overlay of overlays) {
      const result = await runSourceCli({
        root,
        cwd: project,
        args: ["env", "list", "--json", "--env", overlay],
      });
      expect(result.exitCode, `${dir} --env ${overlay}`).toBe(0);
      const parsed: unknown = JSON.parse(result.stdout);
      if (!isRecord(parsed)) {
        throw new Error("env list output is not an object");
      }
      expect(parsed.unknown_scopes, `${dir} --env ${overlay}`).toEqual([]);
      const selection = parsed.env_selection;
      if (overlay !== "base") {
        expect(
          isRecord(selection) && selection.overlay_exists,
          `${dir} --env ${overlay}`
        ).toBe(true);
      }
    }
  };
  // Each example has its own temporary root and private HOME.
  await Promise.all(examples.map((dir) => checkExample(dir)));
}, 120_000);

test("every include block in the recipe pages equals its example file", async () => {
  for (const page of await recipePages()) {
    expect(
      await docIncludeIssues({
        markdown: await Bun.file(page).text(),
        readFile: readRepoFile,
      }),
      basename(page)
    ).toEqual([]);
  }
});

test("every example's config and Compose file are shown on a recipe page", async () => {
  const included = new Set<string>();
  for (const page of await recipePages()) {
    for (const include of parseDocIncludes(await Bun.file(page).text())) {
      included.add(include.path);
    }
  }
  for (const dir of examples) {
    expect(included.has(`${dir}/.hack/hack.config.json`), dir).toBe(true);
    expect(included.has(`${dir}/.hack/docker-compose.yml`), dir).toBe(true);
  }
});

test("negative controls: the example checks reject the mistakes they guard", async () => {
  const compose = await readRecord(
    join(
      REPO_ROOT,
      "examples/configs/api-worker-queue/.hack/docker-compose.yml"
    )
  );
  const mutate = (change: (copy: Record<string, unknown>) => void) => {
    const copy = structuredClone(compose);
    change(copy);
    return copy;
  };
  const service = (copy: Record<string, unknown>, name: string) => {
    const entry = isRecord(copy.services) ? copy.services[name] : undefined;
    if (!isRecord(entry)) {
      throw new Error("missing service");
    }
    return entry;
  };
  const rules = {
    configName: "api-worker-queue",
    devHost: "api-worker-queue.hack.local",
  };
  expect(composeIssues({ compose, ...rules })).toEqual([]);
  expect(depsPatternIssues(compose)).toEqual([]);

  expect(
    depsPatternIssues(
      mutate((copy) => {
        service(copy, "worker").depends_on = {
          queue: { condition: "service_healthy" },
        };
      })
    )
  ).toEqual(["worker: not-gated-on-deps"]);
  expect(
    depsPatternIssues(
      mutate((copy) => {
        service(copy, "api").volumes = ["..:/app"];
      })
    )
  ).toEqual(["api: missing-deps-volume"]);
  expect(
    depsPatternIssues(
      mutate((copy) => {
        service(copy, "deps").command = ["bun", "install"];
      })
    )
  ).toEqual(["deps-install-not-locked"]);
  expect(
    composeIssues({
      compose: mutate((copy) => {
        service(copy, "queue").image = "redis:latest";
        service(copy, "api").networks = ["default"];
        service(copy, "api").labels = { caddy: "other.hack.local" };
      }),
      ...rules,
    })
  ).toEqual([
    "api: route-outside-dev-host",
    "api: route-without-hack-dev",
    "queue: image-latest",
  ]);

  expect(
    lockfileIssues({ pinned: ["zod@4.1.12"], lockfile: '"zod@4.1.13"' })
  ).toEqual(["dependency-not-in-lockfile"]);
  expect(lockfileIssues({ pinned: ["zod@^4.1.12"], lockfile: "" })).toEqual([
    "dependency-not-exact",
  ]);
  expect(lockfileIssues({ pinned: ["zod@4.1.12"], lockfile: null })).toEqual([
    "missing-lockfile",
  ]);

  expect(
    envFileIssues({
      fileName: "hack.env.qa.yaml",
      document: {
        version: 1,
        environment: "staging",
        values: { worker: { TOKEN: { secure: "v1:x" } } },
      },
      serviceNames: ["api"],
    })
  ).toEqual([
    "env-name-differs-from-file",
    "env-unknown-scope",
    "env-committed-secret",
  ]);
  expect(
    envFileIssues({
      fileName: "hack.env.qa.local.yaml",
      document: {},
      serviceNames: [],
    })
  ).toEqual(["local-env-file-committed"]);

  const page = await Bun.file(join(RECIPES_DIR, "deps-service.md")).text();
  const composeInclude = parseDocIncludes(page).find((include) =>
    include.path.endsWith("deps-service/.hack/docker-compose.yml")
  );
  if (!composeInclude) {
    throw new Error("deps-service.md does not include its Compose file");
  }
  const stale = page.replace("oven/bun:1.4.4-slim", "oven/bun:1.4.3-slim");
  expect(stale).not.toBe(page);
  expect(
    await docIncludeIssues({ markdown: stale, readFile: readRepoFile })
  ).toEqual([
    `line ${composeInclude.line} (examples/recipes/deps-service/.hack/docker-compose.yml): include-out-of-date`,
  ]);
  expect(
    await docIncludeIssues({
      markdown: "<!-- include: examples/missing.yml -->\n```yaml\nx\n```\n",
      readFile: readRepoFile,
    })
  ).toEqual(["line 1 (examples/missing.yml): include-file-missing"]);
  expect(
    await docIncludeIssues({
      markdown: "<!-- include: examples/missing.yml -->\ntext\n",
      readFile: readRepoFile,
    })
  ).toEqual(["line 1 (examples/missing.yml): include-without-code-block"]);
});

composeConfigTest(
  "docker compose config accepts every example Compose file",
  async () => {
    for (const dir of examples) {
      const { root, project } = await copyExample(dir);
      const child = Bun.spawn({
        cmd: [
          "docker",
          "compose",
          "-f",
          join(project, ".hack/docker-compose.yml"),
          "config",
          "--quiet",
        ],
        cwd: project,
        env: privateCliEnv({
          root,
          env: { DOCKER_HOST: "unix:///nonexistent/docker.sock" },
        }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: CLI_TIMEOUT_MS,
      });
      const [stderr, exitCode] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ dir, exitCode, stderr }).toEqual({
        dir,
        exitCode: 0,
        stderr: "",
      });
    }
  },
  120_000
);
