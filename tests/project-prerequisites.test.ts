import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
} from "../src/constants.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import { HACK_VERSION } from "../src/lib/hack-version.ts";
import { parseProjectConfigRecord } from "../src/lib/project.ts";
import {
  enforceProjectPrerequisites,
  inspectProjectPrerequisites,
} from "../src/lib/project-prerequisites.ts";
import { renderProjectConfigSchemaJson } from "../src/templates.ts";
import { validateJsonSchemaSubset } from "./helpers/json-schema-subset.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";
import { runPrivateTtyCli } from "./helpers/private-cli-tty.ts";

test("Compose projects declare a supported minimum CLI version", () => {
  expect(
    parseProjectConfigRecord({ requires: {} }, "fixture.json").prerequisites
      ?.error?.code
  ).toBe("E_MIN_CLI_VERSION_REQUIRED");
  expect(
    parseProjectConfigRecord({ min_cli_version: "latest" }, "fixture.json")
      .prerequisites?.error?.code
  ).toBe("E_INVALID_MIN_CLI_VERSION");
  expect(
    parseProjectConfigRecord({ min_cli_version: "999.0.0" }, "fixture.json")
      .prerequisites?.error?.code
  ).toBe("E_CLI_VERSION_TOO_OLD");
});

test("config refuses undeclared host tool references", () => {
  const cfg = parseProjectConfigRecord(
    {
      min_cli_version: HACK_VERSION,
      requires: {
        cloud: {
          kind: "aws-sso",
          profile: "example-dev",
          tools: ["cloud-cli"],
        },
      },
    },
    "fixture.json"
  );
  expect(cfg.prerequisites?.error?.code).toBe("E_UNKNOWN_HOST_TOOL");
});

test("a failed check reports its exit code without its process output", async () => {
  const marker = "SYNTHETIC_CHECK_OUTPUT";
  const cfg = parseProjectConfigRecord(
    {
      min_cli_version: HACK_VERSION,
      requires: {
        cloud: {
          check: [
            "sh",
            "-c",
            `printf '%s' ${marker}; printf '%s' ${marker} >&2; exit 42`,
          ],
          login: ["true"],
        },
      },
      remotes: {
        db: {
          default: "qa",
          targets: {
            qa: {
              hostname: "db.example.test",
              port: 5432,
              requires: ["cloud"],
            },
          },
        },
      },
    },
    "fixture.json"
  );
  try {
    await enforceProjectPrerequisites(cfg.prerequisites, true, process.cwd());
    throw new Error("Prerequisite should have blocked the command");
  } catch (error) {
    expect(error).toBeInstanceOf(HackCliError);
    if (!(error instanceof HackCliError)) {
      throw error;
    }
    expect(error.code).toBe("E_PREREQUISITE_CHECK_FAILED");
    expect(error.detail).toEqual({ exitCode: 42 });
    expect(error.message).toBe(
      "! cloud  sign-in expired\n  db (qa) needs it. run:\n  true"
    );
    expect(JSON.stringify(error)).not.toContain(marker);
  }
});

test("Compose lifecycle refuses before running hooks with a missing prerequisite tool", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-prerequisites-"));
  try {
    const configDir = join(root, ".hack");
    const marker = join(root, "hook-ran");
    await mkdir(configDir);
    await writeFile(
      join(configDir, PROJECT_COMPOSE_FILENAME),
      "services:\n  api:\n    environment: [DB_HOST]\n"
    );
    await writeFile(
      join(configDir, PROJECT_CONFIG_FILENAME),
      JSON.stringify({
        min_cli_version: HACK_VERSION,
        tools: {
          "cloud-cli": {
            bins: ["unavailable-fixture-cloud"],
            install: "Install the example cloud CLI.",
          },
        },
        requires: {
          cloud: { check: ["true"], login: ["true"], tools: ["cloud-cli"] },
        },
        remotes: {
          db: {
            env: { DB_HOST: "{host}" },
            default: "qa",
            targets: {
              qa: {
                hostname: "db.example.test",
                port: 5432,
                requires: ["cloud"],
              },
            },
          },
        },
        startup: [{ name: "marker", run: "touch hook-ran", cwd: root }],
      })
    );
    const cli = resolve(import.meta.dir, "../index.ts");
    const env = privateCliEnv({ root, env: { HACK_NO_INTERACTIVE: "1" } });
    for (const argv of [
      ["up", "--json"],
      ["restart", "--json"],
      ["run", "api"],
      ["run", "--detach", "--json", "api"],
    ]) {
      const result = Bun.spawnSync([process.execPath, cli, ...argv], {
        cwd: root,
        env,
      });
      expect(result.exitCode).toBe(1);
      expect(await Bun.file(marker).exists()).toBe(false);
      if (argv.includes("--json")) {
        expect(JSON.parse(result.stdout.toString())).toMatchObject({
          ok: false,
          error: { code: "E_PREREQUISITE_TOOL_MISSING" },
        });
      } else {
        expect(result.stderr.toString()).toContain(
          "! unavailable-fixture-cloud  not found (cloud-cli)"
        );
        expect(result.stderr.toString()).toContain(
          "Install the example cloud CLI."
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host tool OS overrides supply the current platform bins and hint", () => {
  const config = parseProjectConfigRecord(
    {
      min_cli_version: HACK_VERSION,
      tools: {
        "cloud-cli": {
          bins: ["aws"],
          install: "Install the base CLI.",
          os: {
            [process.platform]: {
              bins: ["aws-local"],
              install: "Install the platform CLI.",
            },
          },
        },
      },
    },
    "fixture.json"
  );
  expect(config.prerequisites?.config?.tools.get("cloud-cli")).toEqual({
    bins: ["aws-local"],
    install: "Install the platform CLI.",
  });
});

test("prerequisite check resolves an argument relative to the selected project", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-prerequisite-root-"));
  try {
    await writeFile(join(root, "check.sh"), "exit 0\n");
    const cfg = parseProjectConfigRecord(
      {
        min_cli_version: HACK_VERSION,
        requires: { cloud: { check: ["sh", "check.sh"], login: ["true"] } },
        remotes: {
          db: {
            env: { DB_HOST: "{host}" },
            default: "qa",
            targets: {
              qa: {
                hostname: "db.example.test",
                port: 5432,
                requires: ["cloud"],
              },
            },
          },
        },
      },
      "fixture.json"
    );
    expect(
      await enforceProjectPrerequisites(cfg.prerequisites, true, root)
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("schema and parser both refuse malformed new config blocks", () => {
  const base = { name: "fixture", dev_host: "fixture.hack.local" };
  const target = { hostname: "db.example.test", port: 5432 };
  const remoteConfig = (qa: unknown) => ({
    ...base,
    min_cli_version: HACK_VERSION,
    remotes: { db: { default: "qa", targets: { qa } } },
  });
  const valid = remoteConfig(target);
  expect(
    validateJsonSchemaSubset({
      schema: JSON.parse(renderProjectConfigSchemaJson()),
      value: valid,
    })
  ).toEqual([]);
  expect(
    parseProjectConfigRecord(valid, "fixture.json").parseError
  ).toBeUndefined();
  for (const value of [
    remoteConfig({ ...target, require: ["cloud"] }),
    remoteConfig({ ...target, via: 1 }),
    remoteConfig({ ...target, confirm: [] }),
    remoteConfig({ ...target, port: 65_536 }),
    {
      ...base,
      min_cli_version: HACK_VERSION,
      requires: { cloud: { check: ["true"], login: ["true"], typo: true } },
    },
    { ...base, tools: { cloud: { bins: ["aws"] } } },
  ]) {
    expect(
      validateJsonSchemaSubset({
        schema: JSON.parse(renderProjectConfigSchemaJson()),
        value,
      })
    ).not.toEqual([]);
    expect(
      parseProjectConfigRecord(value, "fixture.json").prerequisites?.error
    ).toBeDefined();
  }
});

test("explicit service selection checks only remotes with matching environment keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-prerequisite-services-"));
  try {
    const composeFile = join(root, "compose.yaml");
    await writeFile(
      composeFile,
      "services:\n  api:\n    depends_on: [prepare]\n  prepare:\n    depends_on:\n      migrate:\n        condition: service_completed_successfully\n  migrate:\n    environment: [DB_HOST]\n  worker:\n    environment: [OTHER_HOST]\n"
    );
    const cfg = parseProjectConfigRecord(
      {
        min_cli_version: HACK_VERSION,
        requires: { cloud: { check: ["false"], login: ["true"] } },
        remotes: {
          db: {
            env: { DB_HOST: "{host}" },
            default: "qa",
            targets: {
              qa: {
                hostname: "db.example.test",
                port: 5432,
                requires: ["cloud"],
              },
            },
          },
        },
      },
      "fixture.json"
    );
    expect(
      await enforceProjectPrerequisites(cfg.prerequisites, true, root, {
        composeFile,
        services: ["worker"],
      })
    ).toBe(true);
    await expect(
      enforceProjectPrerequisites(cfg.prerequisites, true, root, {
        composeFile,
        services: ["api"],
      })
    ).rejects.toMatchObject({ code: "E_PREREQUISITE_CHECK_FAILED" });
    await writeFile(join(root, "service.env"), "DB_HOST=db.example.test\n");
    await writeFile(
      composeFile,
      "services:\n  worker:\n    env_file: [service.env]\n"
    );
    await expect(
      enforceProjectPrerequisites(cfg.prerequisites, true, root, {
        composeFile,
        services: ["worker"],
      })
    ).rejects.toMatchObject({ code: "E_PREREQUISITE_CHECK_FAILED" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("check exits and timeouts stop descendants and report distinct outcomes", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-prerequisite-timeout-"));
  try {
    const check = async (command: string) => {
      const cfg = parseProjectConfigRecord(
        {
          min_cli_version: HACK_VERSION,
          requires: {
            cloud: { check: ["sh", "-c", command], login: ["true"] },
          },
          remotes: {
            db: {
              default: "qa",
              targets: {
                qa: {
                  hostname: "db.example.test",
                  port: 5432,
                  requires: ["cloud"],
                },
              },
            },
          },
        },
        "fixture.json"
      );
      return await enforceProjectPrerequisites(cfg.prerequisites, true, root);
    };
    expect(
      await check("(sleep 1; touch normal-exit-child-survived) & exit 0")
    ).toBe(true);
    await expect(
      check("(sleep 1; touch failed-exit-child-survived) & exit 1")
    ).rejects.toMatchObject({
      code: "E_PREREQUISITE_CHECK_FAILED",
    });
    await Bun.sleep(1250);
    expect(
      await Bun.file(join(root, "normal-exit-child-survived")).exists()
    ).toBe(false);
    expect(
      await Bun.file(join(root, "failed-exit-child-survived")).exists()
    ).toBe(false);
    await expect(check("kill -KILL $$")).rejects.toMatchObject({
      code: "E_PREREQUISITE_CHECK_FAILED",
      detail: { signal: "SIGKILL" },
    });
    await expect(
      check("(sleep 11; touch child-survived) & wait")
    ).rejects.toMatchObject({
      code: "E_PREREQUISITE_CHECK_TIMEOUT",
    });
    await Bun.sleep(1250);
    expect(await Bun.file(join(root, "child-survived")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 16_000);

test("failed check output stays private and noninteractive TTY does not start login", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-prerequisite-tty-"));
  try {
    const configDir = join(root, ".hack");
    await mkdir(configDir);
    await writeFile(
      join(configDir, PROJECT_COMPOSE_FILENAME),
      "services: {}\n"
    );
    const outputMarker = "SYNTHETIC_CHECK_STDOUT_AND_STDERR";
    await writeFile(
      join(configDir, PROJECT_CONFIG_FILENAME),
      JSON.stringify({
        min_cli_version: HACK_VERSION,
        requires: {
          cloud: {
            check: [
              "sh",
              "-c",
              `echo ${outputMarker}; echo ${outputMarker} >&2; exit 1`,
            ],
            login: ["touch", "login-started"],
          },
        },
        remotes: {
          db: {
            default: "qa",
            targets: {
              qa: {
                hostname: "db.example.test",
                port: 5432,
                requires: ["cloud"],
              },
            },
          },
        },
      })
    );
    const env = privateCliEnv({ root, env: { HACK_NO_INTERACTIVE: "1" } });
    const piped = Bun.spawnSync(
      [
        process.execPath,
        resolve(import.meta.dir, "../index.ts"),
        "up",
        "--json",
      ],
      { cwd: root, env }
    );
    expect(piped.exitCode).toBe(1);
    expect(JSON.parse(piped.stdout.toString()).error.code).toBe(
      "E_PREREQUISITE_CHECK_FAILED"
    );
    expect(piped.stdout.toString() + piped.stderr.toString()).not.toContain(
      outputMarker
    );
    const tty = await runPrivateTtyCli({
      cwd: root,
      env,
      args: ["up", "--no-interactive"],
    });
    expect(tty.exitCode).toBe(1);
    expect(tty.stderr).toContain("! cloud  sign-in expired");
    expect(tty.stderr).not.toContain(outputMarker);
    expect(tty.stderr).not.toContain("run it now?");
    expect(await Bun.file(join(root, "login-started")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Doctor reports a custom prerequisite without executing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-prerequisite-doctor-"));
  try {
    const parsed = parseProjectConfigRecord(
      {
        min_cli_version: HACK_VERSION,
        requires: {
          cloud: {
            check: ["touch", "check-ran"],
            login: ["true"],
          },
        },
      },
      "fixture.json"
    );
    const config = parsed.prerequisites?.config;
    expect(config).toBeDefined();
    if (!config) {
      throw new Error("Expected a parsed prerequisite declaration.");
    }
    expect(await inspectProjectPrerequisites(config, root)).toEqual([
      {
        name: "cloud",
        login: "true",
        state: { state: "not checked" },
        tools: ["touch", "true"].map((bin) => ({
          bin,
          path: Bun.which(bin),
          source: "PATH",
        })),
      },
    ]);
    expect(await Bun.file(join(root, "check-ran")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a project dotenv file cannot override the AWS preset executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-prerequisite-dotenv-"));
  try {
    const checkout = join(root, "project");
    const configDir = join(checkout, ".hack");
    const binDir = join(root, "bin");
    const override = join(checkout, "fake-aws");
    await mkdir(configDir, { recursive: true });
    await mkdir(binDir);
    const aws = join(binDir, "aws");
    await writeFile(aws, "#!/bin/sh\nexit 42\n");
    await chmod(aws, 0o700);
    await writeFile(override, "#!/bin/sh\nexit 23\n");
    await chmod(override, 0o700);
    await writeFile(
      join(checkout, ".env"),
      `HACK_TOOL_AWS_PATH="${override}"\n`
    );
    await writeFile(
      join(configDir, PROJECT_COMPOSE_FILENAME),
      "services: {}\n"
    );
    await writeFile(
      join(configDir, PROJECT_CONFIG_FILENAME),
      JSON.stringify({
        min_cli_version: HACK_VERSION,
        requires: { cloud: { kind: "aws-sso", profile: "example-dev" } },
        remotes: {
          db: {
            default: "qa",
            targets: {
              qa: {
                hostname: "db.example.test",
                port: 5432,
                requires: ["cloud"],
              },
            },
          },
        },
      })
    );
    const env = privateCliEnv({
      root,
      env: {
        HACK_NO_INTERACTIVE: "1",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    });
    const cli = resolve(import.meta.dir, "../index.ts");
    const result = Bun.spawnSync([process.execPath, cli, "up", "--json"], {
      cwd: checkout,
      env,
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      ok: false,
      error: { code: "E_PREREQUISITE_CHECK_FAILED", detail: { exitCode: 42 } },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
