import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

const CLI = resolve(import.meta.dir, "..", "index.ts");
setDefaultTimeout(30_000);
const SENTINEL = "synthetic-migrated-plaintext-value";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});
async function fixture(modern = true) {
  const root = await mkdtemp(join(tmpdir(), "hack-env-output-"));
  roots.push(root);
  await mkdir(join(root, ".hack"));
  await writeFile(join(root, ".hack/hack.config.json"), '{"name":"fixture"}\n');
  await writeFile(
    join(root, ".hack/docker-compose.yml"),
    "services:\n  app:\n    image: alpine:3.22\n"
  );
  if (modern) {
    await writeFile(
      join(root, ".hack/hack.env.default.yaml"),
      `version: 1\nsecretsprovider: project_key\nvalues:\n  global:\n    TOKEN: ${SENTINEL}\n`
    );
  }
  return root;
}
async function cli(root: string, args: readonly string[]) {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: root,
    env: privateCliEnv({
      root,
      env: {
        HACK_NO_INTERACTIVE: "1",
        HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
      },
    }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

test("env list never exposes migrated plaintext in text or JSON and refuses non-TTY reveal", async () => {
  for (const modern of [true, false]) {
    const root = await fixture(modern);
    if (!modern) {
      await writeFile(
        join(root, ".hack/hack.env.json"),
        JSON.stringify({
          version: 1,
          vars: [
            { key: "TOKEN", source: "plain_env", required: false },
            {
              key: "SERVICE_ONLY",
              source: "plain_env",
              required: false,
              services: ["app"],
            },
          ],
        })
      );
      await writeFile(
        join(root, ".hack/.env"),
        `TOKEN=${SENTINEL}\nSERVICE_ONLY=${SENTINEL}\n`
      );
    }
    for (const json of [false, true]) {
      const result = await cli(root, [
        "env",
        "list",
        ...(json ? ["--json"] : []),
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("TOKEN");
      if (!modern) {
        expect(result.stdout).toContain("SERVICE_ONLY");
      }
      expect(result.stdout + result.stderr).not.toContain(SENTINEL);
      if (json) {
        const body = JSON.parse(result.stdout);
        expect(body.vars[0].has_value).toBe(true);
        expect(body.vars[0]).not.toHaveProperty("value");
      }
      for (const flag of ["--show-values", "--show-secrets"]) {
        const reveal = await cli(root, [
          "env",
          "list",
          flag,
          ...(json ? ["--json"] : []),
        ]);
        expect(reveal.code).not.toBe(0);
        expect(reveal.stdout + reveal.stderr).toContain("interactive terminal");
        expect(reveal.stdout + reveal.stderr).not.toContain(SENTINEL);
      }
    }
  }
});

test("TTY listings hide values by default and reveal only with an explicit flag", async () => {
  const root = await fixture();
  for (const [json, reveal] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ] as const) {
    let output = "";
    const terminal = new Bun.Terminal({
      cols: 120,
      rows: 40,
      data(_terminal, data) {
        output += new TextDecoder().decode(data);
      },
    });
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          CLI,
          "env",
          "list",
          ...(reveal ? ["--show-values"] : []),
          ...(json ? ["--json"] : []),
        ],
        {
          cwd: root,
          env: privateCliEnv({ root, env: { HACK_NO_INTERACTIVE: undefined } }),
          terminal,
        }
      );
      expect(await child.exited).toBe(0);
      expect(output.includes(SENTINEL)).toBe(reveal);
      if (json) {
        const row = JSON.parse(output).vars[0];
        if (reveal) {
          expect(row.value).toBe(SENTINEL);
        } else {
          expect(row).not.toHaveProperty("value");
        }
      }
    } finally {
      terminal.close();
    }
  }
});

test("secret values in arguments are refused before writes; explicit compatibility is available for sentinel fixtures", async () => {
  const root = await fixture(false);
  for (const command of ["add", "set"]) {
    const result = await cli(root, [
      "env",
      command,
      "TOKEN",
      SENTINEL,
      "--secret",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("--value-stdin");
    expect(result.stdout + result.stderr).not.toContain(SENTINEL);
    expect(
      await Bun.file(join(root, ".hack/hack.env.default.yaml")).exists()
    ).toBe(false);
    expect(await Bun.file(join(root, ".hack.secret.key")).exists()).toBe(false);
  }
  const compat = await cli(root, [
    "env",
    "add",
    "TOKEN",
    SENTINEL,
    "--secret",
    "--allow-secret-argv",
  ]);
  expect(compat.code).toBe(0);
  expect(
    await readFile(join(root, ".hack/hack.env.default.yaml"), "utf8")
  ).not.toContain(SENTINEL);
});

test("protect inventory and encryption preserve overlay/scopes without printing values", async () => {
  const root = await fixture();
  await writeFile(
    join(root, ".hack/hack.env.qa.yaml"),
    `version: 1\nsecretsprovider: project_key\nvalues:\n  app:\n    TOKEN: ${SENTINEL}-qa\n`
  );
  const inventory = await cli(root, ["env", "protect", "--json"]);
  expect(inventory.code).toBe(0);
  expect(inventory.stdout).not.toContain(SENTINEL);
  expect(JSON.parse(inventory.stdout).entries).toHaveLength(2);
  const protection = await cli(root, ["env", "protect", "TOKEN", "--json"]);
  expect(protection.code).toBe(0);
  expect(protection.stdout + protection.stderr).not.toContain(SENTINEL);
  expect((await cli(root, ["env", "get", "TOKEN"])).stdout).toBe(SENTINEL);
  expect(
    (
      await cli(root, [
        "env",
        "get",
        "TOKEN",
        "--env",
        "qa",
        "--service",
        "app",
      ])
    ).stdout
  ).toBe(`${SENTINEL}-qa`);
  expect(
    JSON.parse((await cli(root, ["env", "protect", "--json"])).stdout).entries
  ).toEqual([]);
});

test("modern metadata listing does not need a key or decrypt an unavailable encrypted entry", async () => {
  const root = await fixture();
  await writeFile(
    join(root, ".hack/hack.env.default.yaml"),
    `version: 1\nsecretsprovider: project_key\nvalues:\n  global:\n    TOKEN:\n      secure: ${SENTINEL}\n`
  );
  const result = await cli(root, ["env", "list", "--json"]);
  expect(result.code).toBe(0);
  expect(result.stdout + result.stderr).not.toContain(SENTINEL);
  expect(JSON.parse(result.stdout).vars[0]).toMatchObject({
    key: "TOKEN",
    has_value: true,
    storage: { kind: "secret" },
  });
  expect(await Bun.file(join(root, ".hack.secret.key")).exists()).toBe(false);
});
