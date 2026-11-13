import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  childEnvironment,
  HACK_KEY_MATERIAL_VARIABLES,
  hackReexecEnvironment,
} from "../src/lib/child-environment.ts";
import { runLifecycleCommandChild } from "../src/lib/lifecycle-command-child.ts";
import { exec, run } from "../src/lib/shell.ts";
import { restoreEnv } from "./helpers/env.ts";
import { privateCliEnv, privateCliRunEnv } from "./helpers/private-cli-env.ts";

const SENTINEL = "synthetic-child-key-sentinel";
const keys = [...HACK_KEY_MATERIAL_VARIABLES];
const values = Object.fromEntries(keys.map((key) => [key, SENTINEL]));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hack-child-key-"));
  roots.push(root);
  await mkdir(join(root, ".hack"));
  await writeFile(
    join(root, ".hack", "hack.config.json"),
    '{"name":"fixture"}\n'
  );
  await writeFile(
    join(root, ".hack", "docker-compose.yml"),
    "services:\n  app:\n    image: alpine:3.22\n"
  );
  await writeFile(
    join(root, ".hack", "hack.env.default.yaml"),
    "version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global: {}\n"
  );
  return root;
}

test("child env strips inherited and overridden Hack key material without mutating callers", () => {
  expect(
    childEnvironment(
      { ...values, KEEP: "base" },
      { ...values, KEEP: "override" }
    )
  ).toEqual({ KEEP: "override" });
  expect(values.HACK_ENV_SECRET_KEY).toBe(SENTINEL);
  expect(hackReexecEnvironment(values)).toEqual(values);
  expect(
    childEnvironment({ KEEP: "base" }, { KEEP: "override" }, ["KEEP"])
  ).toEqual({ KEEP: "override" });
});

test("shell capture and inherited-output runners strip keys by default", async () => {
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) {
      process.env[key] = values[key];
    }
    const result = await exec(
      [
        process.execPath,
        "-e",
        "console.log(Object.keys(process.env).filter(k => /^HACK_(ENV_SECRET_KEY|SECRETS_FILE_KEY|GATEWAY_(STATIC_)?TOKEN|TAILSCALE_AUTH_KEY)$/.test(k)).length)",
      ],
      { env: values, stdin: "ignore" }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("0");
    expect(
      await run(
        [
          process.execPath,
          "-e",
          "process.exit(process.env.HACK_ENV_SECRET_KEY ? 1 : 0)",
        ],
        { env: values, stdin: "ignore" }
      )
    ).toBe(0);
  } finally {
    for (const key of keys) {
      restoreEnv(key, saved[key]);
    }
  }
});

test("host exec child cannot read a caller's decryption key", async () => {
  const root = await fixture();
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "..", "index.ts"),
      "host",
      "exec",
      "--",
      process.execPath,
      "-e",
      "console.log(JSON.stringify(Object.keys(process.env).filter(k => /^HACK_(ENV_SECRET_KEY|SECRETS_FILE_KEY|GATEWAY_(STATIC_)?TOKEN|TAILSCALE_AUTH_KEY)$/.test(k))))",
    ],
    {
      cwd: root,
      env: privateCliEnv({ root, env: values }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(stdout.trim()).toBe("[]");
});

test("lifecycle hook cannot read keys even when its explicit env contains them", async () => {
  const root = await fixture();
  const output: string[] = [];
  const code = await runLifecycleCommandChild({
    cwd: root,
    command: "env",
    env: privateCliEnv({ root, env: values }),
    drain: async (stream) => {
      output.push(await new Response(stream).text());
    },
  });
  expect(code).toBe(0);
  expect(output.join("")).not.toContain(SENTINEL);
  expect(output.join("")).not.toContain("HACK_ENV_SECRET_KEY=");
});

async function isolatedComposeAvailable(): Promise<boolean> {
  if (!Bun.which("docker")) {
    return false;
  }
  const root = await fixture();
  try {
    const probe = await exec(["docker", "compose", "version"], {
      cwd: root,
      env: privateCliEnv({ root }),
      unsetEnvKeys: Object.keys(process.env),
      stdin: "ignore",
      timeoutMs: 5000,
    });
    return probe.exitCode === 0;
  } finally {
    await rm(root, { recursive: true, force: true });
    roots.splice(roots.indexOf(root), 1);
  }
}

test.skipIf(!(await isolatedComposeAvailable()))(
  "rendered Compose config cannot interpolate either Hack decryption key",
  async () => {
    const root = await fixture();
    const compose = join(root, ".hack", "docker-compose.yml");
    await writeFile(
      compose,
      'services:\n  app:\n    image: alpine:3.22\n    environment:\n      PROJECT_KEY: "${HACK_ENV_SECRET_KEY-unset}"\n      FILE_KEY: "${HACK_SECRETS_FILE_KEY-unset}"\n'
    );
    const env = privateCliEnv({ root, env: values });
    const result = await exec(
      [
        "docker",
        "compose",
        "--project-directory",
        root,
        "-f",
        compose,
        "config",
      ],
      {
        cwd: root,
        env,
        unsetEnvKeys: Object.keys(process.env),
        stdin: "ignore",
      }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PROJECT_KEY: unset");
    expect(result.stdout).toContain("FILE_KEY: unset");
    expect(result.stdout + result.stderr).not.toContain(SENTINEL);
  }
);

test("an explicit Hack re-exec retains its key and filters the eventual host child", async () => {
  const root = await fixture();
  const probe = join(root, "reexec.ts");
  const cli = resolve(import.meta.dir, "..", "index.ts");
  await writeFile(
    probe,
    `if (!process.env.HACK_ENV_SECRET_KEY) process.exit(42);\nawait import(${JSON.stringify(cli)});\n`
  );
  expect(
    await run(
      [
        process.execPath,
        probe,
        "host",
        "exec",
        "--",
        process.execPath,
        "-e",
        "process.exit(process.env.HACK_ENV_SECRET_KEY || process.env.HACK_SECRETS_FILE_KEY ? 43 : 0)",
      ],
      {
        cwd: root,
        ...privateCliRunEnv({ root, env: values }),
        hackReexec: true,
        stdin: "ignore",
      }
    )
  ).toBe(0);
});

const compiledCli = process.env.HACK_TEST_COMPILED_CLI;
test.skipIf(!compiledCli)(
  "compiled re-exec with keys ignores project bunfig preload and dotenv autoload",
  async () => {
    if (!compiledCli) {
      throw new Error(
        "Set HACK_TEST_COMPILED_CLI to the freshly built executable"
      );
    }
    const root = await fixture();
    const marker = join(root, "preload-ran");
    await writeFile(
      join(root, "preload.ts"),
      `await Bun.write(${JSON.stringify(marker)}, process.env.HACK_ENV_SECRET_KEY ? "key-visible" : "executed");\n`
    );
    await writeFile(join(root, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
    await writeFile(join(root, ".env"), `AUTOLOAD_SENTINEL=${SENTINEL}\n`);
    const result = await run(
      [
        compiledCli,
        "host",
        "exec",
        "--",
        "sh",
        "-c",
        'test -z "${AUTOLOAD_SENTINEL-}" && test -z "${HACK_ENV_SECRET_KEY-}"',
      ],
      {
        cwd: root,
        ...privateCliRunEnv({ root, env: values }),
        hackReexec: true,
        stdin: "ignore",
      }
    );
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(result).toBe(0);
  }
);
