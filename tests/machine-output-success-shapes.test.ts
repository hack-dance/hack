import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  JSON_COMMAND_SHAPES,
  SCHEMA_JSON_VARIANTS,
} from "../src/cli/json-contracts.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * Real success output of every listed command that can succeed hermetically
 * (temp HOME, empty working directory, no daemon, engine or network). Each case
 * checks the shape its inventory row declares, so changing either the output
 * or the row without the other fails. Legacy objects pin their top-level keys:
 * adding, removing or wrapping one is a contract change that must be deliberate.
 * Commands needing a runtime, Docker engine, project or macOS (such as
 * `usage`, `doctor` and admin plans) keep their command-specific
 * suites; the usage-error boundary for all of them is in
 * machine-output-contract.test.ts.
 */
const entrypoint = resolve(import.meta.dir, "..", "index.ts");

type Case = {
  readonly command: string;
  readonly flags?: readonly string[];
  readonly keys?: readonly string[];
};

const CASES: readonly Case[] = [
  { command: "version" },
  { command: "config show" },
  { command: "activity" },
  { command: "projects", flags: ["--observe"] },
  { command: "global status", flags: ["--observe"] },
  { command: "projects prune" },
  { command: "upgrade check" },
  {
    command: "projects",
    keys: [
      // Machine-wide always-on policy and login progress (always-on projects).
      "autostart_global",
      "filter",
      "generated_at",
      "include_global",
      "include_meta",
      "include_unregistered",
      "projects",
      "runtime_checked_at",
      "runtime_error",
      "runtime_last_ok_at",
      "runtime_last_repair_at",
      "runtime_next_step",
      "runtime_ok",
      "runtime_repair_action",
      "runtime_repair_outcome",
      "runtime_reset_at",
      "runtime_reset_changes",
      "runtime_reset_count",
      "runtime_reset_summary",
    ],
  },
  {
    command: "host ps",
    keys: ["commands", "generatedAt", "lifecycle", "snapshotAvailable"],
  },
  { command: "node list", keys: ["defaultNodeId", "nodes"] },
  {
    command: "env backend status",
    keys: [
      "allow_env_auth_refs",
      "backend",
      "cloud",
      "encrypted_file",
      "encrypted_file_key_env",
      "status",
      "store_plaintext_in_backend",
    ],
  },
];

function schemaFor(item: Case): string | undefined {
  const flags = item.flags ?? [];
  return SCHEMA_JSON_VARIANTS.find(
    (variant) =>
      variant.command === item.command &&
      variant.flags.join(" ") === flags.join(" ")
  )?.schema;
}

/**
 * The inventory row decides a plain command's shape. Only a flag variant
 * (`projects --observe`) may differ from its base row, and then only through
 * its own SCHEMA_JSON_VARIANTS entry.
 */
function declaredShape(item: Case): string | undefined {
  if ((item.flags ?? []).length > 0) {
    return schemaFor(item) ? "schema-envelope" : undefined;
  }
  return JSON_COMMAND_SHAPES[item.command as keyof typeof JSON_COMMAND_SHAPES];
}

async function runJson(item: Case): Promise<{ code: number; json: unknown }> {
  const root = await mkdtemp(join(tmpdir(), "hack-json-shape-"));
  try {
    const cwd = join(root, "work");
    await mkdir(cwd);
    const child = Bun.spawn(
      [
        process.execPath,
        entrypoint,
        ...item.command.split(" "),
        ...(item.flags ?? []),
        "--json",
      ],
      {
        cwd,
        env: privateCliEnv({
          root,
          env: { HACK_HOME: join(root, "state"), HACK_LOGGER: "console" },
        }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stderr).toBe(0);
    return { code, json: JSON.parse(stdout) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test.each(
  CASES.map((item) => [
    [item.command, ...(item.flags ?? []), "--json"].join(" "),
    item,
  ])
)("%s keeps its inventory success shape", async (_label, item) => {
  const shape = declaredShape(item);
  const { json } = await runJson(item);
  expect(json).toBeObject();
  const result = json as Record<string, unknown>;
  const keys = Object.keys(result).sort();
  if (shape === "schema-envelope" || shape === "envelope") {
    expect(item.keys).toBeUndefined();
    expect(keys).toEqual(["data", "ok"]);
    expect(result.ok).toBe(true);
    expect(result.data).toBeObject();
    const data = result.data as Record<string, unknown>;
    if (shape === "schema-envelope") {
      expect(data.schema).toBe(schemaFor(item));
    }
    return;
  }
  expect(shape).toBe("legacy-object");
  expect(item.keys).toBeDefined();
  expect(keys).toEqual([...(item.keys ?? [])].sort());
});
