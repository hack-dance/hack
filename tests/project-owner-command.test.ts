import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../src/constants.ts";

type CapturedRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

let tempDir: string | null = null;
let originalLogger: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-project-owner-"));
  originalLogger = process.env.HACK_LOGGER;
  process.env.HACK_LOGGER = "console";
});

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  if (originalLogger !== undefined) {
    process.env.HACK_LOGGER = originalLogger;
  } else {
    process.env.HACK_LOGGER = undefined;
  }
});

test("project owner show returns default local ownership as json", async () => {
  const projectRoot = await createHackProject();

  const result = await runCliWithCapturedOutput([
    "project",
    "owner",
    "show",
    "--path",
    projectRoot,
    "--json",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr.trim()).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    project_root: projectRoot,
    project_slug: null,
    ownership: {
      mode: "local",
      owner_type: "user",
      owner_id: null,
      managed_by: "local",
    },
  });
});

test("project owner show returns explicit shared ownership as json", async () => {
  const projectRoot = await createHackProject({
    ownership: {
      mode: "shared",
      owner_type: "organization",
      owner_id: "org_123",
    },
  });

  const result = await runCliWithCapturedOutput([
    "project",
    "owner",
    "show",
    "--path",
    projectRoot,
    "--json",
  ]);

  expect(result.exitCode).toBe(0);
  expect(result.stderr.trim()).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    project_root: projectRoot,
    project_slug: null,
    ownership: {
      mode: "shared",
      owner_type: "organization",
      owner_id: "org_123",
      managed_by: "broker",
    },
  });
});

test("project owner show fails when config parsing fails", async () => {
  const projectRoot = await createHackProject({
    rawConfig: "{ invalid json",
  });

  const result = await runCliWithCapturedOutput([
    "project",
    "owner",
    "show",
    "--path",
    projectRoot,
    "--json",
  ]);

  expect(result.exitCode).toBe(1);
  expect(`${result.stdout}\n${result.stderr}`).toContain("Failed to parse");
});

test("project owner show fails when ownership payload is malformed", async () => {
  const projectRoot = await createHackProject({
    rawConfig: JSON.stringify({
      ownership: [],
    }),
  });

  const result = await runCliWithCapturedOutput([
    "project",
    "owner",
    "show",
    "--path",
    projectRoot,
    "--json",
  ]);

  expect(result.exitCode).toBe(1);
  expect(`${result.stdout}\n${result.stderr}`).toContain(
    "Project ownership must be an object."
  );
});

test("project owner show fails when ownership fields omit mode", async () => {
  const projectRoot = await createHackProject({
    rawConfig: JSON.stringify({
      ownership: {
        owner_type: "team",
        owner_id: "team_123",
      },
    }),
  });

  const result = await runCliWithCapturedOutput([
    "project",
    "owner",
    "show",
    "--path",
    projectRoot,
    "--json",
  ]);

  expect(result.exitCode).toBe(1);
  expect(`${result.stdout}\n${result.stderr}`).toContain(
    "Project ownership.mode is required when ownership.owner_type or ownership.owner_id is set."
  );
});

test("project owner show fails when shared ownership uses a user owner", async () => {
  const projectRoot = await createHackProject({
    rawConfig: JSON.stringify({
      ownership: {
        mode: "shared",
        owner_type: "user",
        owner_id: "user_123",
      },
    }),
  });

  const result = await runCliWithCapturedOutput([
    "project",
    "owner",
    "show",
    "--path",
    projectRoot,
    "--json",
  ]);

  expect(result.exitCode).toBe(1);
  expect(`${result.stdout}\n${result.stderr}`).toContain(
    "Project shared ownership.owner_type must be 'team' or 'organization'."
  );
});

test("project owner show fails when shared ownership omits owner id", async () => {
  const projectRoot = await createHackProject({
    rawConfig: JSON.stringify({
      ownership: {
        mode: "shared",
        owner_type: "team",
      },
    }),
  });

  const result = await runCliWithCapturedOutput([
    "project",
    "owner",
    "show",
    "--path",
    projectRoot,
    "--json",
  ]);

  expect(result.exitCode).toBe(1);
  expect(`${result.stdout}\n${result.stderr}`).toContain(
    "Project shared ownership.owner_id must be a non-empty string."
  );
});

async function createHackProject(opts?: {
  readonly ownership?: {
    readonly mode: "local" | "shared";
    readonly owner_type: "user" | "team" | "organization";
    readonly owner_id?: string;
  };
  readonly rawConfig?: string;
}): Promise<string> {
  if (!tempDir) {
    throw new Error("Missing temp directory");
  }

  const projectRoot = join(tempDir, "repo");
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir, { recursive: true });
  await writeFile(join(projectDir, PROJECT_COMPOSE_FILENAME), "services: {}\n");
  await writeFile(join(projectDir, PROJECT_ENV_FILENAME), "");
  await writeFile(
    join(projectDir, PROJECT_CONFIG_FILENAME),
    opts?.rawConfig ??
      JSON.stringify(
        opts?.ownership
          ? {
              ownership: opts.ownership,
            }
          : {},
        null,
        2
      )
  );

  return projectRoot;
}

async function runCliWithCapturedOutput(
  args: readonly string[]
): Promise<CapturedRunResult> {
  let stdout = "";
  let stderr = "";
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;

  try {
    const { runCli } = await import("../src/cli/run.ts");
    const exitCode = await runCli(args);
    return { exitCode, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}
