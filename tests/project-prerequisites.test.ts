import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
} from "../src/constants.ts";
import { HackCliError } from "../src/lib/cli-result.ts";
import { HACK_VERSION } from "../src/lib/hack-version.ts";
import { parseProjectConfigRecord } from "../src/lib/project.ts";
import { enforceProjectPrerequisites } from "../src/lib/project-prerequisites.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

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
        db: { default: "qa", targets: { qa: { requires: ["cloud"] } } },
      },
    },
    "fixture.json"
  );
  try {
    await enforceProjectPrerequisites(cfg.prerequisites, true);
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
      "services: {}\n"
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
          db: { default: "qa", targets: { qa: { requires: ["cloud"] } } },
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
