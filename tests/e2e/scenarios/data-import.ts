import { createHash } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { DATA_BACKUP_DIGEST_SCRIPT } from "../../../src/lib/data-backup-format.ts";
import {
  dataImportJournalPath,
  writeDataImportJournal,
} from "../../../src/lib/data-import-journal.ts";
import { createMonorepoFixture, type MonorepoFixture } from "../fixture.ts";
import {
  expect,
  expectExit,
  extractJsonObject,
  runCommand,
  type Scenario,
  type ScenarioContext,
} from "../harness.ts";

const TIMEOUT_MS = 300_000;
const HELPER =
  "oven/bun@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4";
const POSTGRES =
  "postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94";
const KEY = "pgdata";

type Envelope = {
  readonly ok?: boolean;
  readonly error?: { readonly code?: string; readonly detail?: unknown };
  readonly data?: {
    readonly schema?: string;
    readonly backup?: string;
    readonly backupId?: string;
    readonly manifest?: {
      readonly volumes?: readonly {
        readonly key: string;
        readonly contentDigest: string;
      }[];
    };
    readonly volumes?: readonly {
      readonly key: string;
      readonly target: string;
      readonly contentDigest: string;
    }[];
  };
};

/**
 * PostgreSQL round trip on a real engine, with the CLI doing every export and
 * import and Compose driving the database (the CLI's `hack up` needs global
 * routing that this tier does not assume). A marker row survives export,
 * volume removal (a move) and import; a second row written after the move
 * survives a second export imported into another project with
 * --from-project. Controls: an interrupted import of our own is recovered on
 * rerun, and a non-empty unlabelled volume with the target name is refused
 * and left identical. Services use `network_mode: none` (psql over the Unix
 * socket), so no network is created; every volume and container is removed
 * by exact name.
 */
export const dataImportScenario: Scenario = {
  name: "data-import",
  tier: "docker",
  summary: "restores PostgreSQL data through export and import, with recovery",
  run: async (ctx) => {
    if ((await docker(ctx, ["info", "--format", "{{.ID}}"])).exitCode !== 0) {
      ctx.skip("docker daemon unavailable (docker info failed)");
    }
    const first = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
    });
    const second = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
    });
    const volumeA = `${first.name}_${KEY}`;
    const volumeB = `${second.name}_${KEY}`;
    const third = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
    });
    const thirdVolumes = ["one", "two"].map((key) => `${third.name}_${key}`);
    const out = join(ctx.tempRoot, "backups");
    try {
      for (const fixture of [first, second]) {
        await Bun.write(composeFile(fixture), renderCompose(fixture.name));
      }
      for (const image of [HELPER, POSTGRES]) {
        expectExit({
          result: await docker(ctx, ["pull", "--quiet", image]),
          codes: [0],
          message: `pull ${image}`,
        });
      }

      await startDatabase(ctx, first);
      await sql(
        ctx,
        first,
        "CREATE TABLE marker (v text); INSERT INTO marker VALUES ('before-move');"
      );
      await compose(ctx, first, ["down"]);

      const backup1 = await exportData(ctx, first, out);
      expectExit({
        result: await docker(ctx, ["volume", "rm", volumeA]),
        codes: [0],
        message: "remove the source volume (a move)",
      });
      const imported = await importData(ctx, first, backup1.path, []);
      expect({
        that:
          imported.data?.schema === "hack.data-import.v1" &&
          imported.data.volumes?.[0]?.target === "created" &&
          imported.data.volumes[0].key === KEY &&
          imported.data.volumes[0].contentDigest === backup1.digest,
        message: "import should create the target and verify its digest",
      });

      await startDatabase(ctx, first);
      expect({
        that:
          (await sql(ctx, first, "SELECT v FROM marker ORDER BY v;")) ===
          "before-move",
        message: "the marker row should survive export, move and import",
      });
      await sql(ctx, first, "INSERT INTO marker VALUES ('after-move');");
      await compose(ctx, first, ["down"]);

      const backup2 = await exportData(ctx, first, out);
      const intoSecond = await importData(ctx, second, backup2.path, [
        "--from-project",
        first.name,
      ]);
      expect({
        that:
          intoSecond.data?.volumes?.[0]?.key === KEY &&
          (await docker(ctx, ["volume", "inspect", volumeB])).exitCode === 0,
        message:
          "--from-project should restore into the second project's volume",
      });
      await startDatabase(ctx, second);
      expect({
        that:
          (await sql(ctx, second, "SELECT v FROM marker ORDER BY v;")) ===
          "after-move\nbefore-move",
        message: "both rows should be readable in the second project",
      });
      await compose(ctx, second, ["down"]);

      // Interruption control: an import that died after creating and
      // partially filling the target, with its journal still `started`.
      await docker(ctx, ["volume", "rm", volumeA]);
      const id = createHash("sha256")
        .update(await readFile(join(backup2.path, "manifest.json")))
        .digest("hex");
      expectExit({
        result: await docker(ctx, [
          "volume",
          "create",
          "--label",
          `com.docker.compose.project=${first.name}`,
          "--label",
          `com.docker.compose.volume=${KEY}`,
          "--label",
          `io.hack.data-backup.source=${id}`,
          volumeA,
        ]),
        codes: [0],
        message: "create the interrupted target",
      });
      const half = Math.floor(
        (await stat(join(backup2.path, `${KEY}.tar`))).size / 2
      );
      await docker(ctx, [
        "run",
        "--rm",
        "--network",
        "none",
        "--volume",
        `${volumeA}:/v`,
        "--volume",
        `${backup2.path}:/b:ro`,
        "--entrypoint",
        "sh",
        HELPER,
        "-c",
        `head -c ${half} /b/${KEY}.tar | tar --numeric-owner -xpf - -C /v; true`,
      ]);
      expect({
        that: (await treeDigest(ctx, volumeA)) !== backup2.digest,
        message: "the simulated interrupted target should hold a partial tree",
      });
      await writeDataImportJournal({
        path: dataImportJournalPath({
          hackHome: ctx.hackHome,
          composeProject: first.name,
          key: KEY,
        }),
        journal: {
          backupId: id,
          backup: backup2.path,
          key: KEY,
          targetSha256: createHash("sha256").update(volumeA).digest("hex"),
          state: "started",
        },
        now: new Date(),
      });
      const recovered = await importData(ctx, first, backup2.path, []);
      expect({
        that:
          recovered.data?.volumes?.[0]?.target === "replaced-partial" &&
          (await treeDigest(ctx, volumeA)) === backup2.digest,
        message: "a rerun should replace its own partial copy and verify",
      });

      // Foreign control: a non-empty unlabelled volume with the target name.
      await docker(ctx, ["volume", "rm", volumeA]);
      await docker(ctx, ["volume", "create", volumeA]);
      await docker(ctx, [
        "run",
        "--rm",
        "--network",
        "none",
        "--volume",
        `${volumeA}:/v`,
        "--entrypoint",
        "sh",
        HELPER,
        "-c",
        "echo precious >/v/keep.txt && chmod 0600 /v/keep.txt",
      ]);
      const before = await treeDigest(ctx, volumeA);
      const refused = await ctx.cli({
        args: ["data", "import", backup2.path, "--json"],
        cwd: first.root,
        timeoutMs: TIMEOUT_MS,
      });
      const refusal = extractJsonObject<Envelope>({ text: refused.stdout });
      expect({
        that:
          refused.exitCode === 1 &&
          refusal?.error?.code === "E_DATA_TARGET_CONFLICT" &&
          (await treeDigest(ctx, volumeA)) === before,
        message:
          "a foreign non-empty target should be refused and left identical",
        result: refused,
      });

      await interruptedBetweenTargets(ctx, third, join(ctx.tempRoot, "third"));
    } finally {
      for (const fixture of [first, second]) {
        await compose(ctx, fixture, ["down", "--volumes"], false);
      }
      await docker(ctx, ["volume", "rm", volumeA, volumeB, ...thirdVolumes]);
    }
  },
};

/**
 * Multi-volume control: a two-volume import whose run ended after the first
 * target completed (the second volume and its journal are gone). The rerun
 * re-verifies the first, read-only, and restores the second.
 */
async function interruptedBetweenTargets(
  ctx: ScenarioContext,
  fixture: MonorepoFixture,
  out: string
): Promise<void> {
  const keys = ["one", "two"] as const;
  await Bun.write(
    composeFile(fixture),
    [
      `name: ${fixture.name}`,
      "services:",
      "  holder:",
      `    image: ${HELPER}`,
      "    network_mode: none",
      "    volumes: [one:/one, two:/two]",
      "volumes:",
      "  one: {}",
      "  two: {}",
      "",
    ].join("\n")
  );
  for (const key of keys) {
    const name = `${fixture.name}_${key}`;
    expectExit({
      result: await docker(ctx, [
        "volume",
        "create",
        "--label",
        `com.docker.compose.project=${fixture.name}`,
        "--label",
        `com.docker.compose.volume=${key}`,
        name,
      ]),
      codes: [0],
      message: `create ${key}`,
    });
    await docker(ctx, [
      "run",
      "--rm",
      "--network",
      "none",
      "--volume",
      `${name}:/v`,
      "--entrypoint",
      "sh",
      HELPER,
      "-c",
      `echo ${key} >/v/${key}.txt && mkdir /v/d && echo nested >/v/d/n`,
    ]);
  }
  const exported = await ctx.cli({
    args: ["data", "export", "--json", "--out", out],
    cwd: fixture.root,
    timeoutMs: TIMEOUT_MS,
  });
  expectExit({ result: exported, codes: [0], message: "export two volumes" });
  const backup = extractJsonObject<Envelope>({ text: exported.stdout })?.data;
  const path = backup?.backup ?? "";
  await docker(ctx, [
    "volume",
    "rm",
    ...keys.map((key) => `${fixture.name}_${key}`),
  ]);
  const full = await importData(ctx, fixture, path, []);
  expect({
    that: full.data?.volumes?.length === 2,
    message: "the first import should restore both volumes",
  });
  // Interrupted after `one` completed, before `two` started.
  await docker(ctx, ["volume", "rm", `${fixture.name}_two`]);
  await rm(
    dataImportJournalPath({
      hackHome: ctx.hackHome,
      composeProject: fixture.name,
      key: "two",
    }),
    { force: true }
  );
  const rerun = await importData(ctx, fixture, path, []);
  const outcomes = (rerun.data?.volumes ?? []).map(
    (volume) => `${volume.key}:${volume.target}`
  );
  const digests = await Promise.all(
    keys.map((key) => treeDigest(ctx, `${fixture.name}_${key}`))
  );
  expect({
    that:
      JSON.stringify(outcomes) ===
        JSON.stringify(["one:verified-complete", "two:created"]) &&
      keys.every(
        (key, index) =>
          backup?.manifest?.volumes?.find((volume) => volume.key === key)
            ?.contentDigest === digests[index]
      ),
    message: "a rerun should verify the completed volume and restore the other",
  });
}

function composeFile(fixture: MonorepoFixture): string {
  return join(fixture.hackDir, "docker-compose.yml");
}

function renderCompose(name: string): string {
  return [
    `name: ${name}`,
    "services:",
    "  db:",
    `    image: ${POSTGRES}`,
    "    network_mode: none",
    "    environment:",
    "      POSTGRES_PASSWORD: fixture",
    // psql and pg_isready in `exec` read it for the loopback connection.
    "      PGPASSWORD: fixture",
    "      POSTGRES_DB: app",
    "    volumes:",
    `      - ${KEY}:/var/lib/postgresql/data`,
    "volumes:",
    `  ${KEY}: {}`,
    "",
  ].join("\n");
}

async function docker(ctx: ScenarioContext, argv: readonly string[]) {
  return await runCommand({
    argv: ["docker", ...argv],
    cwd: ctx.tempRoot,
    timeoutMs: TIMEOUT_MS,
  });
}

async function compose(
  ctx: ScenarioContext,
  fixture: MonorepoFixture,
  argv: readonly string[],
  check = true
) {
  const result = await runCommand({
    argv: [
      "docker",
      "compose",
      "-p",
      fixture.name,
      "-f",
      composeFile(fixture),
      ...argv,
    ],
    cwd: fixture.root,
    timeoutMs: TIMEOUT_MS,
  });
  if (check) {
    expectExit({
      result,
      codes: [0],
      message: `docker compose ${argv.join(" ")}`,
    });
  }
  return result;
}

async function startDatabase(
  ctx: ScenarioContext,
  fixture: MonorepoFixture
): Promise<void> {
  await compose(ctx, fixture, ["up", "--detach"]);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = await compose(
      ctx,
      fixture,
      // The entrypoint's init server listens on the socket only; TCP on
      // loopback answers once the final server is up.
      [
        "exec",
        "-T",
        "db",
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-d",
        "app",
      ],
      false
    );
    if (ready.exitCode === 0) {
      return;
    }
    await Bun.sleep(1000);
  }
  throw new Error(`postgres in ${fixture.name} did not become ready`);
}

async function sql(
  ctx: ScenarioContext,
  fixture: MonorepoFixture,
  statement: string
): Promise<string> {
  const result = await compose(ctx, fixture, [
    "exec",
    "-T",
    "db",
    "psql",
    "-h",
    "127.0.0.1",
    "-U",
    "postgres",
    "-d",
    "app",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    statement,
  ]);
  return result.stdout.trim();
}

async function exportData(
  ctx: ScenarioContext,
  fixture: MonorepoFixture,
  out: string
): Promise<{ readonly path: string; readonly digest: string }> {
  const result = await ctx.cli({
    args: ["data", "export", "--json", "--out", out],
    cwd: fixture.root,
    timeoutMs: TIMEOUT_MS,
  });
  expectExit({ result, codes: [0], message: "hack data export" });
  const payload = extractJsonObject<Envelope>({ text: result.stdout });
  const volume = payload?.data?.manifest?.volumes?.find((v) => v.key === KEY);
  expect({
    that: typeof payload?.data?.backup === "string" && volume !== undefined,
    message: "export should back up the database volume",
    result,
  });
  // Exports in the same second would collide by design; keep them apart.
  await Bun.sleep(1100);
  return {
    path: payload?.data?.backup ?? "",
    digest: volume?.contentDigest ?? "",
  };
}

async function importData(
  ctx: ScenarioContext,
  fixture: MonorepoFixture,
  backup: string,
  extra: readonly string[]
): Promise<Envelope> {
  const result = await ctx.cli({
    args: ["data", "import", backup, ...extra, "--json"],
    cwd: fixture.root,
    timeoutMs: TIMEOUT_MS,
  });
  expectExit({ result, codes: [0], message: "hack data import" });
  return extractJsonObject<Envelope>({ text: result.stdout }) ?? {};
}

async function treeDigest(
  ctx: ScenarioContext,
  volume: string
): Promise<string> {
  const result = await docker(ctx, [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--env",
    "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
    "--volume",
    `${volume}:/v:ro`,
    "--entrypoint",
    "bun",
    HELPER,
    "-e",
    DATA_BACKUP_DIGEST_SCRIPT,
  ]);
  expectExit({ result, codes: [0], message: `digest ${volume}` });
  return (JSON.parse(result.stdout) as { digest: string }).digest;
}
