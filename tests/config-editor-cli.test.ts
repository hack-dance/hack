import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { showConfigEditor } from "../src/lib/config-editor-model.ts";
import { withEnvLayerLock } from "../src/lib/env-layer-lock.ts";
import { privateCliEnv, privateCliHome } from "./helpers/private-cli-env.ts";

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
  return { root, main, linked, project, git };
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
  await writeFile(
    join(f.main, ".hack/hack.env.preview.local.yaml"),
    env("  global:\n    MODE: preview", "preview")
  );
  const before = await show(f.root, f.main);
  expect(before.overlays).toContain("preview");
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
  const linkedPath = join(f.linked, ".hack/hack.config.json");
  await writeFile(linkedPath, '{\n "name": "shop"\n "internal": {}\n}\n');
  const linkedInvalid = await show(f.root, f.linked);
  expect(linkedInvalid.state).toBe("invalid");
  expect(linkedInvalid.issues[0]).toMatchObject({
    layer: "1",
    line: 3,
    code: "E_CONFIG_PARSE",
  });
  expect(linkedInvalid.layers.some((layer) => layer.inherited)).toBe(false);
  await writeFile(path, "{}");
  await chmod(path, 0o444);
  expect((await show(f.root, f.main)).layers[0]?.writable).toBe(false);
});

test("duplicate project JSON properties are reported on the duplicate line before any form write", async () => {
  const f = await fixture();
  const path = join(f.project, "hack.config.json");
  const source = '{\n "name": "first",\n "name": "second"\n}\n';
  await writeFile(path, source);
  const report = await show(f.root, f.main);
  expect(report.state).toBe("invalid");
  expect(report.issues[0]).toMatchObject({
    layer: "1",
    line: 3,
    message: "Each JSON field must appear once.",
  });
  const result = await cli({
    root: f.root,
    cwd: f.main,
    args: ["apply"],
    patch: {
      base: bases(report),
      changes: [{ layer: "1", kind: "project", path: "name", value: "new" }],
    },
  });
  expect(result.payload.ok).toBe(false);
  expect(await readFile(path, "utf8")).toBe(source);
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
  for (const replacement of ["PUBLIC_NAME", "OTHER_TOKEN"]) {
    const refused = await cli({
      root: f.root,
      cwd: f.main,
      args: ["apply"],
      patch: {
        base: bases(current),
        changes: patch.changes.map((change) => ({
          ...change,
          text: change.text.replace("SERVICE_TOKEN", replacement),
        })),
      },
    });
    expect(refused.payload.error.code).toBe("E_CONFIG_INVALID");
  }
});

test("show and validation previews omit authorization headers and commands", async () => {
  const f = await fixture();
  const [projectPath, composePath] = [
    "hack.config.json",
    "docker-compose.yml",
  ].map((file) => join(f.project, file));
  if (!(projectPath && composePath)) {
    throw new Error("Expected fixture layer paths.");
  }
  const command = "curl -H 'Authorization: fixture-ciphertext-marker'";
  await Promise.all([
    writeFile(
      projectPath,
      JSON.stringify({
        name: "storefront",
        startup: [{ run: command }],
        lifecycle: { up: { before: [command] } },
      })
    ),
    writeFile(
      composePath,
      compose
        .replace(
          "- unrelated=kept",
          "- caddy.reverse_proxy.header_up=Authorization Bearer fixture-ciphertext-marker"
        )
        .replace(
          '      caddy.handle_path: "/foo/*"',
          "      caddy.reverse_proxy.header_up: Authorization fixture-ciphertext-marker"
        )
    ),
    writeFile(
      join(f.project, "hack.env.default.yaml"),
      env(
        "  global:\n    REDIS_URL: redis://:fixture-ciphertext-marker@redis.example.test:6379\n    REGISTRY_URL: https://fixture-ciphertext-marker@registry.example.test"
      )
    ),
  ]);
  const report = await show(f.root, f.main);
  expect(report.layers[0]?.hidden).toBe(true);
  expect(report.layers[1]?.hidden).toBe(true);
  expect(
    report.env
      .filter((row) => ["REDIS_URL", "REGISTRY_URL"].includes(row.key))
      .map((row) => row.values[0]?.secret)
  ).toEqual([true, true]);
  const result = await cli({
    root: f.root,
    cwd: f.main,
    args: ["validate"],
    patch: {
      base: bases(report),
      changes: [
        { layer: "1", kind: "project", path: "name", value: "shop" },
        {
          layer: "2",
          kind: "service",
          service: "web",
          field: "image",
          value: "test:latest",
        },
      ],
    },
  });
  expect(result.payload.data.valid).toBe(true);
  expect(result.payload.data.previews["1"]).toContain('"[redacted:');
  expect(result.payload.data.previews["2"]).toContain('"[redacted:');
  await writeFile(
    composePath,
    `${compose}# Registry example https://fixture-ciphertext-marker@registry.example.test\n`
  );
  const privateComment = await show(f.root, f.main);
  expect(privateComment.layers[1]?.source).toBeNull();
  const commentPreview = await cli({
    root: f.root,
    cwd: f.main,
    args: ["validate"],
    patch: {
      base: bases(privateComment),
      changes: [
        {
          layer: "2",
          kind: "service",
          service: "web",
          field: "image",
          value: "test:latest",
        },
      ],
    },
  });
  expect(commentPreview.payload.data.valid).toBe(true);
  expect(commentPreview.payload.data.previews["2"]).toBeNull();
});

test("minimal revisions cannot redirect a stale worktree patch to the main checkout", async () => {
  const f = await fixture();
  const branch = ["--branch", "feature/search"];
  const report = await show(f.root, f.main, ...branch);
  const base = bases(report);
  const main = await show(f.root, f.main);
  // The project JSON is identical and the generated override is missing in both.
  expect(report.layers.find((layer) => layer.id === "6")?.exists).toBe(false);
  expect(base["1"]).not.toBe(bases(main)["1"]);
  f.git(f.main, "worktree", "remove", "--force", f.linked);
  const stale = await cli({
    root: f.root,
    cwd: f.main,
    args: ["apply", ...branch],
    patch: {
      base: { "1": base["1"] },
      changes: [{ layer: "1", kind: "project", path: "name", value: "stale" }],
    },
  });
  expect(stale.payload.error.code).toBe("E_CONFLICT");
  expect((await show(f.root, f.main)).project.name).toBe("storefront");
});

test("the local overlay cannot alias the private base layer, while a tracked local overlay still works", async () => {
  const f = await fixture();
  const overlay = ["--env", "local"];
  const report = await show(f.root, f.main, ...overlay);
  expect(report.layers.find((layer) => layer.id === "3:local")).toBeUndefined();
  const local = report.layers.find((layer) => layer.id === "5");
  expect(local?.file.endsWith("/hack.env.local.yaml")).toBe(true);
  expect(local?.ownership).toBe("local");
  f.git(f.main, "add", "-f", ".hack/hack.env.local.yaml");
  const legacy = await show(f.root, f.main, ...overlay);
  expect(legacy.layers.find((layer) => layer.id === "3:local")).toMatchObject({
    file: local?.file,
    ownership: "shared",
    writable: true,
  });
  expect(legacy.layers.find((layer) => layer.id === "5")?.file).toEndWith(
    "/hack.env.default.local.yaml"
  );
});

test("form and Source validation reject invalid Compose ports, services and hostnames", async () => {
  const f = await fixture();
  const base = bases(await show(f.root, f.main));
  const invalid = [
    [
      {
        layer: "2",
        kind: "service",
        service: "web",
        field: "ports",
        value: ["99999"],
      },
      "2",
    ],
    [{ layer: "2", kind: "source", text: "services:\n  web: 42\n" }, "2"],
    [
      { layer: "1", kind: "source", text: '{\n  "dev_host": "bad host"\n}' },
      "1",
    ],
  ] as const;
  for (const [change, layer] of invalid) {
    const check = await cli({
      root: f.root,
      cwd: f.main,
      args: ["validate"],
      patch: { base, changes: [change] },
    });
    expect(check.payload.data.valid).toBe(false);
    expect(check.payload.data.issues[0]?.layer).toBe(layer);
  }
});

test("oversized serialized project and env files fail preflight before an earlier layer writes", async () => {
  const f = await fixture();
  const base = bases(await show(f.root, f.main));
  const text = "é".repeat(270_000);
  const source = {
    layer: "1",
    kind: "source",
    text: JSON.stringify({ example: text }),
  };
  const project = {
    layer: "1",
    kind: "project",
    path: "name",
    value: "oversize",
  };
  for (const changes of [
    [source],
    [
      project,
      {
        layer: "5",
        kind: "env",
        scope: "global",
        key: "LARGE_VALUE",
        value: text,
      },
    ],
    [
      project,
      {
        layer: "5",
        kind: "env",
        scope: "global",
        key: "LARGE_SECRET",
        value: "a".repeat(410_000),
        secret: true,
      },
    ],
  ]) {
    const check = await cli({
      root: f.root,
      cwd: f.main,
      args: ["apply"],
      patch: { base, changes },
    });
    expect(check.payload.error.code).toBe("E_CONFIG_INVALID");
    expect(check.payload.error.detail.issues[0]?.message).toContain("512 KiB");
  }
  expect(bases(await show(f.root, f.main))).toEqual(base);
});

test("branch routes require an authored or legacy dev host", async () => {
  const f = await fixture();
  await writeFile(join(f.project, "hack.config.json"), "{}");
  const args = ["--branch", "branch-copy"];
  const report = await show(f.root, f.main, ...args);
  expect(report.services.every((service) => service.routes.length === 0)).toBe(
    true
  );
  expect(
    report.issues.some((issue) => issue.path.join(".") === "dev_host")
  ).toBe(true);
  await writeFile(join(f.project, ".env"), "DEV_HOST=storefront.hack\n");
  const withLegacyHost = await show(f.root, f.main, ...args);
  expect(
    withLegacyHost.services.find((service) => service.name === "web")?.routes[0]
      ?.host
  ).toBe("branch-copy.storefront.hack");
});

test("the longest supported overlay can be included in a patch base", async () => {
  const f = await fixture();
  const name = "a".repeat(128);
  await writeFile(
    join(f.project, `hack.env.${name}.yaml`),
    env("  global: {}", name)
  );
  const base = bases(await show(f.root, f.main));
  expect(base[`3:${name}`]).toBeDefined();
  const result = await cli({
    root: f.root,
    cwd: f.main,
    args: ["apply"],
    patch: {
      base,
      changes: [
        { layer: "1", kind: "project", path: "name", value: "long-overlay" },
      ],
    },
  });
  expect(result.payload.ok).toBe(true);
});

test("config set reads project JSON only after acquiring the editor's writer lock", async () => {
  const f = await fixture();
  const layerPath = join(f.project, "hack.config.json");
  const child = await withEnvLayerLock({
    layerPath,
    run: async () => {
      const pending = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          entry,
          "config",
          "set",
          "name",
          "shop",
        ],
        {
          cwd: f.main,
          env: privateCliEnv({ root: f.root }),
          stdout: "ignore",
          stderr: "ignore",
        }
      );
      expect(
        await Promise.race([
          pending.exited,
          Bun.sleep(700).then(() => "waiting"),
        ])
      ).toBe("waiting");
      await writeFile(
        layerPath,
        '{"name":"storefront","dev_host":"editor.hack"}\n'
      );
      return pending;
    },
  });
  expect(await child.exited).toBe(0);
  expect((await show(f.root, f.main)).project).toMatchObject({
    name: "shop",
    dev_host: "editor.hack",
  });
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

test("pending env migration blocks the selected checkout and readers of its inherited layers", async () => {
  const f = await fixture();
  const base = bases(await show(f.root, f.main));
  const primary = await realpath(f.main);
  const hash = new Bun.CryptoHasher("sha256").update(primary).digest("hex");
  const journal = join(privateCliHome(f.root), ".hack/env-migrations", hash);
  await mkdir(journal, { recursive: true, mode: 0o700 });
  await writeFile(
    join(journal, "journal.json"),
    JSON.stringify({
      version: 1,
      kind: "hack-env-migration",
      project: { projectRoot: primary },
      state: "applying",
    }),
    { mode: 0o600 }
  );
  const [selected, inherited, apply] = await Promise.all([
    cli({ root: f.root, cwd: f.main, args: ["show"] }),
    cli({ root: f.root, cwd: f.linked, args: ["show"] }),
    cli({
      root: f.root,
      cwd: f.main,
      args: ["apply"],
      patch: {
        base,
        changes: [
          {
            layer: "5",
            kind: "env",
            scope: "global",
            key: "TEST",
            value: "new",
          },
        ],
      },
    }),
  ]);
  for (const result of [selected, inherited, apply]) {
    expect(result.payload.error.message).toContain("migration is unfinished");
  }
});

test("the first Config env write migrates an existing legacy contract before publishing its change", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-config-legacy-env-"));
  scratch.push(root);
  const cwd = join(root, "legacy");
  const project = join(cwd, ".hack");
  await mkdir(project, { recursive: true });
  const storePath = join(cwd, "legacy-secrets.enc.json");
  const keyPath = join(cwd, "legacy-store.key");
  await Promise.all([
    writeFile(
      join(project, "hack.config.json"),
      JSON.stringify({
        name: "legacy",
        dev_host: "legacy.hack",
        defaultEnvConfig: "qa",
        controlPlane: {
          secrets: {
            backend: "encrypted_file",
            encryptedFile: { path: storePath, keyPath },
          },
        },
      })
    ),
    writeFile(
      join(project, "docker-compose.yml"),
      "services:\n  api:\n    image: test:dev\n"
    ),
    writeFile(
      join(project, "hack.env.json"),
      JSON.stringify({
        version: 1,
        vars: [
          { key: "EXISTING", source: "plain_env", services: ["api"] },
          { key: "ANOTHER", source: "plain_env" },
          { key: "SECRET_TOKEN", source: "keychain", services: ["api"] },
        ],
      })
    ),
    writeFile(join(project, ".env"), "EXISTING=kept\nANOTHER=also-kept\n"),
    writeFile(join(project, ".env.qa"), "ANOTHER=qa-override\n"),
  ]);
  const storeModule = resolve(import.meta.dir, "../src/lib/secret-store.ts");
  const store = Bun.spawn([process.execPath, "--no-env-file", "-"], {
    cwd,
    env: privateCliEnv({ root }),
    stdin: new Blob([
      "import { resolveSecretStore } from ",
      JSON.stringify(storeModule),
      ';\nconst store = await resolveSecretStore({ projectDir: ".hack", projectName: "legacy" });\n',
      'await store.set({ key: "SECRET_TOKEN", value: "fixture-ciphertext-marker" });\n',
    ]),
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await store.exited).toBe(0);
  const selection = ["--env", "new"];
  const before = await show(root, cwd, ...selection);
  const source = before.layers.find((layer) => layer.id === "1")?.source ?? "";
  const patch = {
    base: bases(before),
    changes: [
      {
        layer: "1",
        kind: "source",
        text: source.replace('"legacy"', '"renamed"'),
      },
      { layer: "5", kind: "env", scope: "api", key: "NEW", value: "added" },
      {
        layer: "5:new",
        kind: "env",
        scope: "api",
        key: "NEW_OVERLAY",
        value: "chosen",
      },
    ],
  };
  const heldKey = join(cwd, "held-test-key");
  await rename(keyPath, heldKey);
  const validation = await cli({
    root,
    cwd,
    args: ["validate", ...selection],
    patch,
  });
  expect(validation.payload.data.valid).toBe(true);
  expect(await Bun.file(keyPath).exists()).toBe(false);
  const overlap = await cli({
    root,
    cwd,
    args: ["validate", ...selection],
    patch: {
      ...patch,
      changes: [
        {
          layer: "1",
          kind: "source",
          text: source.replace('"qa"', '"staging"'),
        },
        patch.changes[1],
      ],
    },
  });
  expect(overlap.payload.data.issues[0]?.message).toContain("same setting");
  await rename(heldKey, keyPath);
  const applied = await cli({
    root,
    cwd,
    args: ["apply", ...selection],
    patch,
  });
  expect(applied.payload.ok).toBe(true);
  expect(applied.payload.data.restart_offered).toBe(true);
  expect(applied.payload.data.changed).toEqual(
    expect.arrayContaining(["3:qa", "5:qa", "5:new"])
  );
  const after = await show(root, cwd);
  expect(after.project.name).toBe("renamed");
  expect(after.project.defaultEnvConfig).toBeUndefined();
  expect(after.project.env).toMatchObject({ defaultOverlay: "qa" });
  expect(after.env.find((row) => row.key === "SECRET_TOKEN")).toMatchObject({
    scope: "api",
    values: [expect.objectContaining({ secret: true })],
  });
  expect(
    after.env.map((row) => [row.key, row.scope, row.values[0]?.value])
  ).toEqual(
    expect.arrayContaining([
      ["EXISTING", "api", "kept"],
      ["ANOTHER", "global", "also-kept"],
      ["NEW", "api", "added"],
    ])
  );
});

test("Config preflights malformed and oversized legacy migration data before applying a mixed patch", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-config-legacy-preflight-"));
  scratch.push(root);
  const project = join(root, ".hack");
  await mkdir(project);
  const original = '{"name":"legacy","dev_host":"legacy.hack"}\n';
  const projectFile = join(project, "hack.config.json");
  const contract = join(project, "hack.env.json");
  const oversizedValue = "é".repeat(270_000);
  await Promise.all([
    writeFile(projectFile, original),
    writeFile(
      join(project, "docker-compose.yml"),
      "services:\n  api:\n    image: test:dev\n"
    ),
    writeFile(contract, "{"),
    writeFile(
      join(project, ".env"),
      ["EXISTING=", oversizedValue, "\n"].join("")
    ),
  ]);
  const before = await show(root, root);
  const patch = {
    base: bases(before),
    changes: [
      { layer: "1", kind: "project", path: "name", value: "renamed" },
      { layer: "5", kind: "env", scope: "api", key: "NEW", value: "added" },
    ],
  };
  const malformed = await cli({ root, cwd: root, args: ["validate"], patch });
  expect(malformed.payload.data.issues[0]?.message).toContain("env contract");
  await writeFile(
    contract,
    '{"version":1,"vars":[{"key":"EXISTING","source":"plain_env"}]}\n'
  );
  const oversized = await cli({ root, cwd: root, args: ["apply"], patch });
  expect(oversized.payload.error.detail.issues[0]?.message).toContain(
    "512 KiB"
  );
  await writeFile(join(project, ".env"), `EXISTING=${"a".repeat(300_000)}\n`);
  const combined = await cli({
    root,
    cwd: root,
    args: ["validate"],
    patch: {
      ...patch,
      changes: [
        {
          layer: "5",
          kind: "env",
          scope: "api",
          key: "NEW",
          value: "b".repeat(300_000),
        },
      ],
    },
  });
  expect(combined.payload.data.issues[0]?.message).toContain("512 KiB");
  expect(await readFile(projectFile, "utf8")).toBe(original);
  expect(bases(await show(root, root))).toEqual(bases(before));
});

test("legacy env validation accepts TOML and reports migration consent before Apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-config-legacy-source-"));
  scratch.push(root);
  for (const format of ["toml", "json"]) {
    const cwd = join(root, format);
    const project = join(cwd, ".hack");
    await mkdir(project, { recursive: true });
    await Promise.all([
      writeFile(
        join(project, "docker-compose.yml"),
        "services:\n  api:\n    image: alpine\n"
      ),
      writeFile(
        join(project, "hack.env.json"),
        '{"version":1,"vars":[{"key":"LEGACY","source":"plain_env"}]}\n'
      ),
      writeFile(
        join(project, ".env"),
        format === "toml" ? "" : "LEGACY=retained\n"
      ),
      format === "toml"
        ? writeFile(
            join(project, "hack.toml"),
            'name = "legacy"\ndev_host = "legacy.hack"\n'
          )
        : writeFile(
            join(project, "hack.config.json"),
            '{"name":"legacy","dev_host":"legacy.hack","defaultEnvConfig":"qa"}\n'
          ),
    ]);
    if (format === "json") {
      for (const args of [
        ["init", "-b", "main"],
        ["add", ".hack/hack.config.json"],
      ]) {
        expect(
          Bun.spawnSync(["git", "-C", cwd, ...args], {
            env: privateCliEnv({ root }),
            stdout: "ignore",
            stderr: "ignore",
          }).exitCode
        ).toBe(0);
      }
    }
    const selection = ["--env", "default"];
    const before = await show(root, cwd, ...selection);
    const patch = {
      base: bases(before),
      changes: [
        {
          layer: "5",
          kind: "env",
          scope: "global",
          key: "NEW",
          value: "added",
        },
      ],
    };
    const { payload } = await cli({
      root,
      cwd,
      patch,
      args: ["validate", ...selection],
    });
    if (format === "toml") {
      expect(payload.data.valid).toBe(true);
      expect(
        (await cli({ root, cwd, patch, args: ["apply", ...selection] })).payload
          .ok
      ).toBe(true);
      expect(await Bun.file(join(project, ".gitignore")).exists()).toBe(true);
    } else {
      expect(payload.data.valid).toBe(false);
      expect(payload.data.issues[0]?.message).toContain(
        "--accept-tracked-env-changes"
      );
    }
  }
});

test("legacy env validation matches empty values, Compose order, and normalized JSON size", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-config-legacy-preflight-"));
  scratch.push(root);
  const project = join(root, ".hack");
  await mkdir(project);
  const json = join(project, "hack.config.json");
  const composeFile = join(project, "docker-compose.yml");
  const ignore = join(project, ".gitignore");
  const settings = { name: "legacy", dev_host: "legacy.hack" };
  const simpleCompose = "services:\n  api:\n    image: alpine\n";
  await Promise.all([
    writeFile(json, JSON.stringify(settings)),
    writeFile(composeFile, simpleCompose),
    writeFile(ignore, "# tracked legacy rules\n"),
    writeFile(join(project, ".env"), "OPTIONAL=\n"),
    writeFile(
      join(project, "hack.env.json"),
      '{"version":1,"vars":[{"key":"OPTIONAL","source":"plain_env"}]}\n'
    ),
  ]);
  for (const args of [
    ["init", "-b", "main"],
    ["add", ".hack/.gitignore"],
  ]) {
    expect(
      Bun.spawnSync(["git", "-C", root, ...args], {
        env: privateCliEnv({ root }),
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode
    ).toBe(0);
  }
  const change = {
    layer: "3",
    kind: "env",
    scope: "global",
    key: "NEW",
    value: "added",
  };
  const selection = ["--env", "default"];
  const validate = async () =>
    cli({
      root,
      cwd: root,
      args: ["validate", ...selection],
      patch: {
        base: bases(await show(root, root, ...selection)),
        changes: [change],
      },
    });
  expect((await validate()).payload.data.valid).toBe(true);

  const overlaySettings = { ...settings, defaultEnvConfig: "staging" };
  await Promise.all([
    writeFile(json, JSON.stringify(overlaySettings)),
    writeFile(join(project, ".env"), "OPTIONAL=base\n"),
    writeFile(join(project, ".env.staging"), "OPTIONAL=overlay\n"),
    writeFile(
      composeFile,
      `${simpleCompose}    env_file: [.env.staging, .env]\n`
    ),
  ]);
  const order = await validate();
  expect(order.payload.data.issues[0]?.message).toContain(
    "order of Compose env_file"
  );

  await writeFile(composeFile, simpleCompose);
  await writeFile(
    json,
    JSON.stringify({
      ...overlaySettings,
      custom: Array.from({ length: 100_000 }, () => 0),
    })
  );
  const large = await validate();
  expect(large.payload.data.issues[0]?.message).toContain("512 KiB");
});

async function legacyContractWorktree(baseValue: string) {
  const f = await fixture();
  const project = join(f.linked, ".hack");
  f.git(
    f.linked,
    "rm",
    "--",
    ".hack/hack.env.default.yaml",
    ".hack/hack.env.qa.yaml"
  );
  await Promise.all([
    rm(join(project, "hack.env.local.yaml")),
    writeFile(join(project, ".env"), `LOG_LEVEL=${baseValue}\n`),
    writeFile(
      join(project, "hack.env.json"),
      '{"version":1,"vars":[{"key":"LOG_LEVEL","source":"plain_env"}]}\n'
    ),
  ]);
  return { ...f, linkedProject: project };
}

test("a worktree's initial legacy unset journals only a needed ignore repair", async () => {
  for (const alreadyIgnored of [false, true]) {
    const f = await legacyContractWorktree("");
    const project = f.linkedProject;
    const ignore = join(await realpath(project), ".gitignore");
    await rm(join(f.project, "hack.env.local.yaml"));
    if (alreadyIgnored) {
      await writeFile(ignore, "# tracked old ignore rules\n");
      f.git(f.linked, "add", ".hack/.gitignore");
    } else {
      await writeFile(join(f.linked, ".gitignore"), ".hack/.internal/\n");
    }
    const selection = ["--env", "default"];
    const before = await show(f.root, f.linked, ...selection);
    expect(before.layers.some((layer) => layer.id === "4")).toBe(true);
    const patch = {
      base: bases(before),
      changes: [
        {
          layer: "5",
          kind: "env",
          scope: "global",
          key: "LOG_LEVEL",
          value: null,
        },
      ],
    };
    const validate = await cli({
      root: f.root,
      cwd: f.linked,
      args: ["validate", ...selection],
      patch,
    });
    expect(validate.payload.data.valid).toBe(true);
    const outcome = await cli({
      root: f.root,
      cwd: f.linked,
      args: ["apply", ...selection],
      patch,
    });
    expect(outcome.payload.ok).toBe(true);
    expect(
      await readFile(join(project, "hack.env.local.yaml"), "utf8")
    ).toContain("LOG_LEVEL: null");
    const hash = new Bun.CryptoHasher("sha256")
      .update(await realpath(f.linked))
      .digest("hex");
    const journal = JSON.parse(
      await readFile(
        join(
          privateCliHome(f.root),
          ".hack/env-migrations",
          hash,
          "journal.json"
        ),
        "utf8"
      )
    );
    expect(
      journal.writes.some(
        (file: { path: string; done: boolean }) =>
          file.path === ignore && file.done
      )
    ).toBe(!alreadyIgnored);
    if (alreadyIgnored) {
      expect(await readFile(ignore, "utf8")).toBe(
        "# tracked old ignore rules\n"
      );
    }
  }
});

test("disabling worktree inheritance and writing env migrates legacy values in the same save", async () => {
  const f = await legacyContractWorktree("legacy-configured");
  const selection = ["--env", "default"];
  const before = await show(f.root, f.linked, ...selection);
  expect(before.layers.some((layer) => layer.id === "4" && layer.exists)).toBe(
    true
  );
  const patch = {
    base: bases(before),
    changes: [
      {
        layer: "1",
        kind: "project",
        path: "worktree.inherit_local",
        value: false,
      },
      { layer: "5", kind: "env", scope: "global", key: "NEW", value: "added" },
    ],
  };
  const validation = await cli({
    root: f.root,
    cwd: f.linked,
    args: ["validate", ...selection],
    patch,
  });
  expect(validation.payload.data.valid).toBe(true);
  const apply = await cli({
    root: f.root,
    cwd: f.linked,
    args: ["apply", ...selection],
    patch,
  });
  expect(apply.payload.ok).toBe(true);
  const saved = await readFile(
    join(f.linkedProject, "hack.env.local.yaml"),
    "utf8"
  );
  expect(saved).toContain("LOG_LEVEL: legacy-configured");
  expect(saved).toContain("NEW: added");
  expect(
    (await show(f.root, f.linked, ...selection)).layers.some(
      (layer) => layer.id === "4"
    )
  ).toBe(false);
});

test("an identical replacement layer directory invalidates a revision", async () => {
  const f = await fixture();
  const report = await show(f.root, f.main);
  const projectPath = join(f.project, "hack.config.json");
  const original = await readFile(projectPath, "utf8");
  const old = join(f.main, ".old-hack");
  await rename(f.project, old);
  await mkdir(f.project);
  await Promise.all([
    writeFile(projectPath, original),
    writeFile(join(f.project, "docker-compose.yml"), compose),
  ]);
  const result = await cli({
    root: f.root,
    cwd: f.main,
    args: ["apply"],
    patch: {
      base: { "1": bases(report)["1"] },
      changes: [{ layer: "1", kind: "project", path: "name", value: "wrong" }],
    },
  });
  expect(result.payload.error.code).toBe("E_CONFLICT");
  expect(await readFile(projectPath, "utf8")).toBe(original);
});

test("validation reads newly selected layers and honors an explicit selection", async () => {
  const f = await fixture();
  const checkOverlay = async (value: string, args: string[] = []) =>
    await cli({
      root: f.root,
      cwd: f.main,
      args: ["validate", ...args],
      patch: {
        base: bases(await show(f.root, f.main, ...args)),
        changes: [
          { layer: "1", kind: "project", path: "env.defaultOverlay", value },
        ],
      },
    });
  await writeFile(join(f.project, "hack.env.qa.yaml"), "invalid: [");
  const qa = await checkOverlay("qa");
  expect(qa.payload.data.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ layer: "3:qa", code: "E_CONFIG_PARSE" }),
    ])
  );
  expect(
    (await checkOverlay("qa", ["--env", "default"])).payload.data.valid
  ).toBe(true);
  expect((await checkOverlay("a".repeat(129))).payload.data.valid).toBe(false);
  await writeFile(
    join(f.project, "hack.config.json"),
    '{"dev_host":"storefront.hack","env":{"defaultOverlay":"default"}}'
  );
  const base = await show(f.root, f.main);
  expect(base.overlay).toBeNull();
  expect(
    base.layers.filter((layer) => layer.file.endsWith("hack.env.default.yaml"))
  ).toHaveLength(1);

  await writeFile(join(f.linked, ".hack/hack.config.json"), "{}");
  const cfg = await show(f.root, f.linked);
  const patch = {
    base: bases(cfg),
    changes: [
      {
        layer: "1",
        kind: "project",
        path: "worktree.auto_branch",
        value: false,
      },
    ],
  };
  const implicit = await cli({
    root: f.root,
    cwd: f.linked,
    args: ["validate"],
    patch,
  });
  expect(implicit.payload.data.valid).toBe(true);
  const explicit = ["--branch", "feature-search"];
  const explicitCheck = await cli({
    root: f.root,
    cwd: f.linked,
    args: ["validate", ...explicit],
    patch: { ...patch, base: bases(await show(f.root, f.linked, ...explicit)) },
  });
  expect(explicitCheck.payload.data.valid).toBe(false);
});

test("an include-only Compose root permits project and env edits", async () => {
  const f = await fixture();
  const composeFile = join(f.project, "docker-compose.yml");
  const root = "include:\n  - path: [services.yml]\n";
  await Promise.all([
    writeFile(composeFile, root),
    writeFile(
      join(f.project, "services.yml"),
      "services:\n  api:\n    image: alpine\n"
    ),
  ]);
  const report = await show(f.root, f.main);
  expect(report.state).toBe("ready");
  expect(report.services).toEqual([]);
  const patch = {
    base: bases(report),
    changes: [
      { layer: "1", kind: "project", path: "name", value: "renamed" },
      {
        layer: "3",
        kind: "env",
        scope: "global",
        key: "ADDED",
        value: "shared",
      },
    ],
  };
  expect(
    (await cli({ root: f.root, cwd: f.main, args: ["validate"], patch }))
      .payload.data.valid
  ).toBe(true);
  expect(
    (await cli({ root: f.root, cwd: f.main, args: ["apply"], patch })).payload
      .ok
  ).toBe(true);
  expect(await readFile(composeFile, "utf8")).toBe(root);
});

test("Compose ports and labels match runtime interpretation and sequence edits keep comments", async () => {
  const f = await fixture();
  const file = join(f.project, "docker-compose.yml");
  await writeFile(
    file,
    compose
      .replace(
        "    depends_on: [api]",
        "    ports:\n      - '127.0.0.1::80' # loopback target\n      - '8081:81' # published target\n      - 80 # http\n      - 443 # https\n      - '${PORT:-8080}:80'\n    depends_on:\n      - api # API dependency"
      )
      .replace("      - unrelated=kept", "      - caddy=last.storefront.hack")
  );
  const report = await show(f.root, f.main);
  const web = report.services.find((service) => service.name === "web");
  expect(web?.routes.map((route) => route.host)).toEqual([
    "last.storefront.hack",
  ]);
  expect(web?.route_edit).toBeNull();
  const check = async (changes: unknown[]) =>
    await cli({
      root: f.root,
      cwd: f.main,
      args: ["validate"],
      patch: { base: bases(report), changes },
    });
  const valid = await check([
    {
      layer: "2",
      kind: "service",
      service: "web",
      field: "ports",
      value: [
        "443",
        "80",
        "${PORT:-8080}:80",
        "127.0.0.${OCTET:-1}:8080:80",
        "127.0.0.1:${PORT_MAPPING:-8080:80}",
        "127.0.0.1:${PUBLISHED_AND_COLON:-8080:}80",
        "127${MIDDLE:-.0.}0.1:8080:80",
        ":8080:80",
        "[]:8080:80",
        "[::${ADDR:-1}]:8080:80",
        "[2001${SEP:-:}db8::1]:8080:80",
        "::1:8080:80",
        "127.0.0.1::80",
        "8082:81",
      ],
    },
    {
      layer: "2",
      kind: "service",
      service: "web",
      field: "depends_on",
      value: ["api", "worker"],
    },
  ]);
  expect(valid.payload.data.valid).toBe(true);
  const interpolatedDependency = await check([
    {
      layer: "2",
      kind: "source",
      text: 'services:\n  web:\n    depends_on:\n      api: {condition: "service_${WHEN:-started}"}\n  api: {}\n',
    },
  ]);
  expect(interpolatedDependency.payload.data.valid).toBe(true);
  for (const comment of [
    "# loopback target",
    "# published target",
    "# API dependency",
    "443 # https",
    "80 # http",
  ]) {
    expect(valid.payload.data.previews["2"]).toContain(comment);
  }
  const invalidMappings = [
    "'8082-8081:81'",
    "'127.0.0.999:8081:81'",
    "{published: 8081}",
    "'${PORT:-8080}:70000'",
    "'127.0.0.1:${PUBLISHED_AND_COLON:-8080:}70000'",
    "'${PORT'",
    "'invalid-host.${OCTET:-1}:8080:80'",
    "'[12345::${ADDR:-1}]:8080:80'",
    "'[1:2:3:4:5:6:7:8:${TAIL:-9}]:8080:80'",
    "'[fe80::1%${IFACE:-en0}]:8080:80'",
    "'[fe80::1%en0]:8080:80'",
  ];
  const invalid = await check([
    {
      layer: "2",
      kind: "source",
      text: [
        "services:",
        ...invalidMappings.map(
          (mapping, index) => `  port-${index}:\n    ports: [${mapping}]`
        ),
        "  scalar:\n    depends_on: web",
        "  missing:\n    depends_on:\n      web: {}",
        "  typo:\n    depends_on:\n      web: {condition: typo}",
        "  web: {}",
      ].join("\n"),
    },
  ]);
  expect(invalid.payload.data.valid).toBe(false);
  expect(invalid.payload.data.issues).toHaveLength(invalidMappings.length + 3);
  const self = await check([
    {
      layer: "2",
      kind: "service",
      service: "web",
      field: "depends_on",
      value: ["web"],
    },
  ]);
  expect(self.payload.data.valid).toBe(false);
  const cycles = await check([
    {
      layer: "2",
      kind: "service",
      service: "api",
      field: "depends_on",
      value: ["web"],
    },
  ]);
  expect(cycles.payload.data.issues[0]?.message).toContain("dependency cycle");
  const unequal = await check([
    {
      layer: "2",
      kind: "service",
      service: "web",
      field: "ports",
      value: ["8000-8002:80-81"],
    },
  ]);
  expect(unequal.payload.data.valid).toBe(false);
});

test("an authored dev_host avoids opening a legacy dotenv input", async () => {
  const f = await fixture();
  const legacy = join(f.project, ".env");
  await mkdir(legacy);
  expect((await show(f.root, f.main)).state).toBe("ready");
  await writeFile(join(f.project, "hack.config.json"), "{}");
  const fallback = await cli({ root: f.root, cwd: f.main, args: ["show"] });
  expect(fallback.payload.error.code).toBe("E_PERMISSION");
});
