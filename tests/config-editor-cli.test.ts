import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { showConfigEditor } from "../src/lib/config-editor-model.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

setDefaultTimeout(45_000);

const entry = resolve(import.meta.dir, "../index.ts");
const scratch: string[] = [];
type Report = ReturnType<typeof showConfigEditor>;

afterEach(async () => {
  for (const path of scratch.splice(0)) {
    await rm(path, { force: true, recursive: true });
  }
});

const compose = `# Project comment
name: storefront
services:
  web:
    image: storefront-web:dev # keep image comment
    labels:
      - caddy=storefront.hack # keep route comment
      - caddy.reverse_proxy={{upstreams 3000}}
      - unrelated=kept
    depends_on: [api]
  api:
    image: storefront-api:dev
    labels:
      caddy: "api.storefront.hack, api.external.hack"
      caddy.reverse_proxy: "{{upstreams 3000}}"
    ports:
      - target: 3000
        published: 8300
  worker:
    labels:
      caddy: worker.storefront.hack
      caddy.reverse_proxy: "{{upstreams 9000}}"
      caddy.handle_path: "/foo/*"
`;

function env(contents: string, name = "default"): string {
  return `version: 1\nenvironment: ${name}\nsecretsprovider: project_key\nvalues:\n${contents}\n`;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hack-config-editor-"));
  scratch.push(root);
  const main = join(root, "main");
  const project = join(main, ".hack");
  await mkdir(project, { recursive: true });
  await Promise.all([
    writeFile(
      join(project, "hack.config.json"),
      '{"name":"storefront","dev_host":"storefront.hack","internal":{"dns":true}}\n'
    ),
    writeFile(join(project, "docker-compose.yml"), compose),
    writeFile(
      join(project, "hack.env.default.yaml"),
      env(
        "  global:\n    LOG_LEVEL: info\n  api:\n    SEARCH_INDEX: products\n    SERVICE_TOKEN:\n      secure: fixture-ciphertext-marker"
      )
    ),
    writeFile(
      join(project, "hack.env.qa.yaml"),
      env("  global:\n    SEARCH_INDEX: qa-index", "qa")
    ),
    writeFile(
      join(main, ".gitignore"),
      ".hack/.internal/\n.hack/hack.env*.local.yaml\n"
    ),
  ]);
  const cliEnv = privateCliEnv({ root });
  const git = (cwd: string, ...args: string[]) => {
    const command = Bun.spawnSync(["git", "-C", cwd, ...args], { env: cliEnv });
    expect(command.exitCode).toBe(0);
  };
  git(main, "init", "-b", "main");
  git(main, "add", ".");
  git(
    main,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "fixture"
  );
  const linked = join(root, "linked");
  git(main, "worktree", "add", "-b", "feature/search", linked);
  await Promise.all([
    writeFile(
      join(project, "hack.env.local.yaml"),
      env("  global:\n    LOG_LEVEL: debug")
    ),
    writeFile(
      join(linked, ".hack/hack.env.local.yaml"),
      env("  api:\n    SEARCH_INDEX: products_fs")
    ),
  ]);
  return { root, main, linked, project };
}

async function cli(opts: {
  root: string;
  cwd: string;
  args: string[];
  patch?: unknown;
}) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      entry,
      "config",
      ...opts.args,
      "--json",
    ],
    {
      cwd: opts.cwd,
      env: privateCliEnv({ root: opts.root }),
      stdin:
        opts.patch === undefined
          ? "ignore"
          : new Blob([JSON.stringify(opts.patch)]),
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(`${out}\n${err}`.includes("fixture-ciphertext-marker")).toBe(false);
  return { code, payload: JSON.parse(out) };
}

async function show(
  root: string,
  cwd: string,
  ...args: string[]
): Promise<Report> {
  const result = await cli({ root, cwd, args: ["show", ...args] });
  expect(result.code).toBe(0);
  expect(result.payload.ok).toBe(true);
  expect(result.payload.data.schema).toBe("hack.config.v1");
  return result.payload.data;
}

function bases(report: Report) {
  return Object.fromEntries(
    report.layers.map((layer) => [layer.id, layer.revision])
  );
}

test("show resolves the selected linked checkout, route namespaces, env layers and redaction", async () => {
  const f = await fixture();
  const report = await show(
    f.root,
    f.main,
    "--branch",
    "feature/search",
    "--env",
    "qa"
  );
  expect(report.checkout).toBe(f.linked);
  expect(report.branch).toBe("feature-search");
  expect(report.overlay).toBe("qa");
  expect(report.layers.find((layer) => layer.id === "4")).toMatchObject({
    inherited: true,
    writable: false,
  });
  expect(report.layers.find((layer) => layer.id === "6")).toMatchObject({
    ownership: "generated",
    writable: false,
  });
  expect(
    report.services.find((service) => service.name === "api")?.routes
  ).toEqual([
    {
      host: "api.feature-search.storefront.hack",
      port: 3000,
      tls: true,
      from: ["2", "6"],
    },
  ]);
  expect(report.env.find((row) => row.key === "SERVICE_TOKEN")).toMatchObject({
    scope: "api",
    winning: "3",
    values: [{ layer: "3", secret: true }],
  });
  expect(report.env.find((row) => row.key === "LOG_LEVEL")).toMatchObject({
    scope: "global",
    winning: "4",
  });
  expect(
    report.env.find((row) => row.scope === "api" && row.key === "SEARCH_INDEX")
  ).toMatchObject({ winning: "5" });
  const before = await show(f.root, f.main);
  expect(before.layers.find((layer) => layer.id === "3:qa")).toMatchObject({
    active: false,
    writable: false,
  });
  await writeFile(
    join(f.linked, ".hack/hack.config.json"),
    '{"name":"storefront","dev_host":"storefront.hack","worktree":{"inherit_local":false}}'
  );
  const optedOut = await show(f.root, f.linked);
  expect(optedOut.layers.some((layer) => layer.id === "4")).toBe(false);
});

test("validate is nonmutating and apply publishes one revision per file, retaining Compose comments and order", async () => {
  const f = await fixture();
  const report = await show(f.root, f.linked);
  const args = { root: f.root, cwd: f.linked };
  const patch = {
    base: bases(report),
    changes: [
      { layer: "1", kind: "project", path: "internal.tls", value: true },
      {
        layer: "2",
        kind: "route",
        service: "web",
        sites: "storefront.hack, shop.storefront.hack",
        port: 8080,
      },
      {
        layer: "5",
        kind: "env",
        scope: "api",
        key: "SEARCH_INDEX",
        value: "products_new",
      },
      { layer: "5", kind: "env", scope: "api", key: "PAGE_SIZE", value: "50" },
    ],
  };
  const validated = await cli({ ...args, args: ["validate"], patch });
  expect(validated.payload.data.valid).toBe(true);
  expect(validated.payload.data.previews["2"]).toContain(
    "# keep route comment"
  );
  expect(
    await readFile(join(f.linked, ".hack/docker-compose.yml"), "utf8")
  ).toBe(compose);
  const applied = await cli({ ...args, args: ["apply"], patch });
  expect(applied.payload.data).toEqual({
    schema: "hack.config.v1",
    changed: ["1", "2", "5"],
    restart_offered: true,
  });
  const next = await show(f.root, f.linked);
  const source = next.layers.find((layer) => layer.id === "2")?.source ?? "";
  expect(source).toContain(
    "caddy=storefront.hack, shop.storefront.hack # keep route comment"
  );
  expect(source).toContain("caddy.reverse_proxy={{upstreams 8080}}");
  expect(source.indexOf("  web:")).toBeLessThan(source.indexOf("  api:"));
  expect(next.env.find((row) => row.key === "PAGE_SIZE")?.values).toEqual([
    { layer: "5", secret: false, value: "50" },
  ]);
  expect(next.project.internal).toEqual({ dns: true, tls: true });
  expect(
    (await cli({ ...args, args: ["apply"], patch })).payload.error.code
  ).toBe("E_CONFLICT");
});

test("refuses generated layers and rejects an invalid prospective source with a line", async () => {
  const f = await fixture();
  const report = await show(f.root, f.linked);
  const args = { root: f.root, cwd: f.linked };
  const base = bases(report);
  const readonly = await cli({
    ...args,
    args: ["apply"],
    patch: {
      base,
      changes: [{ layer: "6", kind: "source", text: "services: {}" }],
    },
  });
  expect(readonly.payload.error.code).toBe("E_LAYER_READ_ONLY");
  const custom = await cli({
    ...args,
    args: ["validate"],
    patch: {
      base,
      changes: [
        {
          layer: "2",
          kind: "route",
          service: "worker",
          sites: "worker.storefront.hack",
          port: 3000,
        },
      ],
    },
  });
  expect(custom.payload.data.issues[0]).toMatchObject({
    layer: "2",
    message: "Edit this route in Source.",
  });
  const text = compose.replace("depends_on: [api]", "depends_on: [cache]");
  const invalid = await cli({
    ...args,
    args: ["validate"],
    patch: { base, changes: [{ layer: "2", kind: "source", text }] },
  });
  expect(invalid.payload.data.valid).toBe(false);
  expect(invalid.payload.data.issues[0]).toMatchObject({
    layer: "2",
    path: ["services", "web", "depends_on"],
    line: 10,
  });
  expect(
    await readFile(join(f.linked, ".hack/docker-compose.yml"), "utf8")
  ).toBe(compose);
});

test("show reports missing, unreadable JSON and read-only layers distinctly", async () => {
  const f = await fixture();
  expect((await show(f.root, f.root)).state).toBe("missing");
  const path = join(f.project, "hack.config.json");
  await writeFile(path, '{\n "name": "shop"\n "internal": {}\n}\n');
  const invalid = await show(f.root, f.main);
  expect(invalid.state).toBe("invalid");
  expect(invalid.issues[0]).toMatchObject({
    layer: "1",
    line: 3,
    code: "E_CONFIG_PARSE",
  });
  expect(invalid.layers[0]?.source).toBeNull();
  await writeFile(path, "{}");
  await chmod(path, 0o444);
  expect((await show(f.root, f.main)).layers[0]?.writable).toBe(false);
});

test("a revision conflict preflights all layers without applying earlier changes", async () => {
  const f = await fixture();
  const report = await show(f.root, f.main);
  const before = await readFile(join(f.project, "hack.config.json"), "utf8");
  const external = `${compose}\n# changed outside Hack\n`;
  await writeFile(join(f.project, "docker-compose.yml"), external);
  const result = await cli({
    root: f.root,
    cwd: f.main,
    args: ["apply"],
    patch: {
      base: bases(report),
      changes: [
        {
          layer: "1",
          kind: "project",
          path: "dev_host",
          value: "new.storefront.hack",
        },
      ],
    },
  });
  expect(result.code).toBe(1);
  expect(result.payload.error.code).toBe("E_CONFLICT");
  expect(await readFile(join(f.project, "hack.config.json"), "utf8")).toBe(
    before
  );
  expect(await readFile(join(f.project, "docker-compose.yml"), "utf8")).toBe(
    external
  );
});

test("Source saves surrounding edits while preserving private slots", async () => {
  const f = await fixture();
  const file = join(f.project, "docker-compose.yml");
  const original = compose.replace(
    "    image: storefront-web:dev",
    "    environment:\n      SERVICE_TOKEN: fixture-ciphertext-marker\n    image: storefront-web:dev"
  );
  await writeFile(file, original);
  const report = await show(f.root, f.main);
  const layer = report.layers.find((item) => item.id === "2");
  expect(layer?.source_writable).toBe(true);
  expect(layer?.source).toContain('"[redacted:1]"');
  const before = layer?.source ?? "";
  const patch = {
    base: bases(report),
    changes: [
      {
        layer: "2",
        kind: "source",
        text: before.replace("storefront-web:dev", "storefront-web:test"),
      },
    ],
  };
  const applied = await cli({
    root: f.root,
    cwd: f.main,
    args: ["apply"],
    patch,
  });
  expect(applied.payload.ok).toBe(true);
  expect(
    (await readFile(file, "utf8")) ===
      original.replace("storefront-web:dev", "storefront-web:test")
  ).toBe(true);
  const current = await show(f.root, f.main);
  const changed = patch.changes.map((change) => ({
    ...change,
    text: change.text.replace("SERVICE_TOKEN", "PUBLIC_NAME"),
  }));
  const refused = await cli({
    root: f.root,
    cwd: f.main,
    args: ["apply"],
    patch: { base: bases(current), changes: changed },
  });
  expect(refused.payload.error.code).toBe("E_CONFIG_INVALID");
});

test("a concurrent apply using the same base can commit only once", async () => {
  const f = await fixture();
  const base = bases(await show(f.root, f.main));
  const outcomes = await Promise.all(
    ["first", "second"].map((value) =>
      cli({
        root: f.root,
        cwd: f.main,
        args: ["apply"],
        patch: {
          base,
          changes: [{ layer: "1", kind: "project", path: "name", value }],
        },
      })
    )
  );
  const failures = outcomes.filter((outcome) => outcome.code === 1);
  expect(failures).toHaveLength(1);
  expect(failures[0]?.payload.error.code).toBe("E_CONFLICT");
});
