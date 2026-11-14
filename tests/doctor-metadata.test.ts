import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildDoctorJsonData } from "../src/commands/doctor.ts";
import { okResult } from "../src/lib/cli-result.ts";
import { doctorMetadata } from "../src/lib/doctor-metadata.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

test("doctor metadata distinguishes machine and project findings", () => {
  for (const id of [
    "docker",
    "network:hack-dev subnet",
    "resolver:hack",
    "daemon service",
  ]) {
    expect(doctorMetadata({ id }).scope).toBe("machine");
  }
  for (const id of [
    "project",
    "env key",
    "hack gitignore",
    "native settings",
    "lifecycle hygiene",
  ]) {
    expect(doctorMetadata({ id }).scope).toBe("project");
  }
  expect(doctorMetadata({ id: "local ca trust" })).toMatchObject({
    area: "certificates",
    scope: "machine",
    fix: { kind: "admin", args: ["global", "trust"] },
  });
  expect(
    doctorMetadata({ id: "secrets hygiene", scope: "machine" }).scope
  ).toBe("machine");
});

test("unknown checks and inherited object names offer no executable repair", () => {
  for (const id of [
    "new future check",
    "__proto__",
    "constructor",
    "toString",
  ]) {
    expect(doctorMetadata({ id })).toMatchObject({
      area: "other",
      scope: "project",
      fix: { kind: "manual", args: [] },
    });
  }
});

test("versioned doctor audit keeps schema inside data and never parses repair instructions", () => {
  const data = buildDoctorJsonData({
    results: [
      {
        name: "env key",
        status: "error",
        message: "run: sudo injected-command",
        durationMs: 0,
      },
    ],
  });
  expect(data).toMatchObject({
    schema: 1,
    counts: { error: 1 },
    checks: [
      {
        area: "env_secrets",
        scope: "project",
        fix: { kind: "manual", args: [] },
      },
    ],
  });
  const envelope = okResult({ data });
  expect(Object.keys(envelope)).toEqual(["ok", "data"]);
  expect(envelope.data.schema).toBe(1);
});

test("secrets hygiene reports its actual scope inside and outside a project", async () => {
  const root = await mkdtemp(join(tmpdir(), "doctor-metadata-"));
  try {
    const project = join(root, "project");
    await mkdir(join(project, ".hack"), { recursive: true });
    await Bun.write(
      join(project, ".hack/docker-compose.yml"),
      "services: {}\n"
    );
    const modulePath = resolve(import.meta.dir, "../src/commands/doctor.ts");
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--eval",
        `
      import {checkSecretsHygiene} from ${JSON.stringify(modulePath)};
      const checks = [];
      for (const startDir of process.argv.slice(1)) checks.push(await checkSecretsHygiene({startDir}));
      process.stdout.write(JSON.stringify(checks.map(check => check.scope)));
    `,
        root,
        project,
      ],
      {
        cwd: root,
        env: privateCliEnv({
          root,
          env: {
            HACK_HOME: join(root, "state"),
            HACK_GLOBAL_CONFIG_PATH: join(root, "state/hack.config.json"),
            HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
          },
        }),
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(["machine", "project"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
