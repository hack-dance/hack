import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dataComposeArgs } from "../../../src/commands/data.ts";
import { HackCliError } from "../../../src/lib/cli-result.ts";
import {
  createHostDataBackupDocker,
  type DataBackupDocker,
} from "../../../src/lib/data-backup-docker.ts";
import { exportProjectData } from "../../../src/lib/data-backup-export.ts";
import {
  DATA_BACKUP_ARCHIVE_DIGEST_SCRIPT,
  DATA_BACKUP_DIGEST_SCRIPT,
} from "../../../src/lib/data-backup-format.ts";
import { isRecord } from "../../../src/lib/guards.ts";
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
/** The storage witness pin `hack data export` reuses. */
const HELPER =
  "oven/bun@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4";

type ExportPayload = {
  readonly ok?: boolean;
  readonly error?: { readonly code?: string; readonly detail?: unknown };
  readonly data?: {
    readonly schema?: string;
    readonly backup?: string;
    readonly manifest?: {
      readonly schema?: string;
      readonly composeProjectSha256?: string;
      readonly helperImage?: string;
      readonly volumes?: readonly {
        readonly key: string;
        readonly nameSha256: string;
        readonly file: string;
        readonly tarBytes: number;
        readonly tarSha256: string;
        readonly entries: number;
        readonly excludedSockets: number;
        readonly contentDigest: string;
      }[];
      readonly skipped?: readonly {
        readonly key: string;
        readonly reason: string;
      }[];
    };
  };
};

/**
 * Real engine: a named volume with a symlink and an owner/mode-specific file
 * is exported through the pinned helper; the tar lists them with numeric
 * owners, the host tar sha256 matches, and the content digest equals the one
 * the helper computes for the same tree. External and foreign volumes are
 * reported and never mounted; a running project container refuses. Every
 * Docker object is created and removed here by exact name, without Compose,
 * so no network is left.
 */
export const dataExportScenario: Scenario = {
  name: "data-export",
  tier: "docker",
  summary: "exports owned Compose volumes to verified tar files",
  run: async (ctx) => {
    const info = await docker(ctx, ["info", "--format", "{{.ServerVersion}}"]);
    if (info.exitCode !== 0) {
      ctx.skip("docker daemon unavailable (docker info failed)");
    }
    const fixture = await createMonorepoFixture({
      parentDir: ctx.tempRoot,
      withHackConfig: true,
    });
    const project = fixture.name;
    const data = `${project}_data`;
    const foreign = `${project}-foreign`;
    const external = `${project}-external`;
    const runner = `${project}-web-1`;
    const scratch = `${project}-restore`;
    const writer = `${project}-writer`;
    await Bun.write(
      join(fixture.hackDir, "docker-compose.yml"),
      [
        `name: ${project}`,
        "services:",
        "  web:",
        `    image: ${HELPER}`,
        "    volumes: [data:/data, other:/other, shared:/shared]",
        "volumes:",
        "  data: {}",
        "  other:",
        `    name: ${foreign}`,
        "  shared:",
        "    external: true",
        `    name: ${external}`,
        "",
      ].join("\n")
    );
    try {
      for (const argv of [
        ["pull", "--quiet", HELPER],
        ["volume", "create", ...labels(project, "data"), data],
        ["volume", "create", ...labels(`${project}-else`, "other"), foreign],
        ["volume", "create", external],
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--volume",
          `${data}:/v`,
          "--entrypoint",
          "sh",
          HELPER,
          "-c",
          "echo one >/v/a.txt && ln -s a.txt /v/link && mkdir /v/d && echo two >/v/d/secret && chown 1234:5678 /v/d/secret && chmod 0640 /v/d/secret && mknod /v/d/null c 1 3 && mkfifo /v/d/fifo && ln /v/d/fifo /v/d/fifo2 && ln -P /v/link /v/link2",
        ],
        // A stale Unix socket, like mysql.sock in a datadir: tar skips it,
        // so the digest must leave it out too for a restore to verify.
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--volume",
          `${data}:/v`,
          "--entrypoint",
          "bun",
          HELPER,
          "-e",
          'require("node:net").createServer().listen("/v/d/app.sock", () => process.exit(0))',
        ],
      ]) {
        expectExit({
          result: await docker(ctx, argv),
          codes: [0],
          message: `docker ${argv.slice(0, 2).join(" ")} should succeed`,
        });
      }

      const out = join(ctx.tempRoot, "backups");
      const exported = await ctx.cli({
        args: ["data", "export", "--json", "--out", out],
        cwd: fixture.root,
        timeoutMs: TIMEOUT_MS,
      });
      expectExit({
        result: exported,
        codes: [0],
        message: "export should pass",
      });
      const payload = extractJsonObject<ExportPayload>({
        text: exported.stdout,
      });
      const manifest = payload?.data?.manifest;
      const volume = manifest?.volumes?.[0];
      expect({
        that:
          payload?.data?.schema === "hack.data-export.v1" &&
          manifest?.schema === "hack.data-backup.v1" &&
          manifest.composeProjectSha256 ===
            new Bun.CryptoHasher("sha256").update(project).digest("hex") &&
          manifest.helperImage === HELPER &&
          manifest.volumes?.length === 1 &&
          volume?.key === "data" &&
          volume.nameSha256 ===
            new Bun.CryptoHasher("sha256").update(data).digest("hex") &&
          volume.entries === 9 &&
          volume.excludedSockets === 1 &&
          JSON.stringify(manifest.skipped) ===
            JSON.stringify([
              { key: "other", reason: "foreign" },
              { key: "shared", reason: "external" },
            ]),
        message: "manifest should list the owned volume and skip the others",
        result: exported,
      });
      const backup = payload?.data?.backup ?? "";
      const onDisk = JSON.parse(
        await readFile(join(backup, "manifest.json"), "utf8")
      );
      expect({
        that: JSON.stringify(onDisk) === JSON.stringify(manifest),
        message: "manifest.json should equal the reported manifest",
      });
      const tarPath = join(backup, volume?.file ?? "");
      const tarBytes = await readFile(tarPath);
      expect({
        that:
          tarBytes.byteLength === volume?.tarBytes &&
          new Bun.CryptoHasher("sha256").update(tarBytes).digest("hex") ===
            volume.tarSha256,
        message: "tar size and sha256 should match the manifest",
      });
      const listing = await runCommand({
        argv: ["tar", "--numeric-owner", "-tvf", tarPath],
        cwd: ctx.tempRoot,
      });
      expect({
        that:
          /^-rw-r----- 1234\/5678 .* \.\/d\/secret$/m.test(listing.stdout) &&
          /^l.* \.\/link -> a\.txt$/m.test(listing.stdout) &&
          /^-.* \.\/a\.txt$/m.test(listing.stdout),
        message: `tar should keep owner, mode and the symlink:\n${listing.stdout}`,
      });
      // The published archive itself digests to the recorded source digest.
      const archived = await docker(ctx, [
        "run",
        "--rm",
        "--network",
        "none",
        "--log-driver",
        "none",
        "--read-only",
        "--tmpfs",
        "/tmp",
        "--env",
        "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0",
        "--volume",
        `${backup}:/b:ro`,
        "--entrypoint",
        "sh",
        HELPER,
        "-c",
        `bun -e "$0" < /b/${volume?.file ?? ""}`,
        DATA_BACKUP_ARCHIVE_DIGEST_SCRIPT,
      ]);
      expect({
        that:
          archived.exitCode === 0 &&
          JSON.parse(archived.stdout).digest === volume?.contentDigest,
        message: "the archive digest should equal the recorded source digest",
        result: archived,
      });
      // Restore the tar into a scratch volume and digest it again: PR 2's check.
      const restored = await docker(ctx, [
        "run",
        "--rm",
        "--network",
        "none",
        "--volume",
        `${scratch}:/v`,
        "--volume",
        `${backup}:/b:ro`,
        "--entrypoint",
        "tar",
        HELPER,
        "--numeric-owner",
        "-xpf",
        `/b/${volume?.file ?? ""}`,
        "-C",
        "/v",
      ]);
      const digest = await docker(ctx, [
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
        `${scratch}:/v:ro`,
        "--entrypoint",
        "bun",
        HELPER,
        "-e",
        DATA_BACKUP_DIGEST_SCRIPT,
      ]);
      expect({
        that:
          restored.exitCode === 0 &&
          JSON.parse(digest.stdout).digest === volume?.contentDigest &&
          JSON.parse(digest.stdout).excludedSockets === 0,
        message:
          "a restored tree (without the socket) should have the recorded content digest",
        result: digest,
      });

      const standIn = await docker(ctx, [
        "run",
        "--detach",
        "--network",
        "none",
        "--name",
        runner,
        "--label",
        `com.docker.compose.project=${project}`,
        "--entrypoint",
        "sleep",
        HELPER,
        "300",
      ]);
      expectExit({
        result: standIn,
        codes: [0],
        message: "a stand-in project container should start",
      });
      const refused = await ctx.cli({
        args: ["data", "export", "--json", "--out", out],
        cwd: fixture.root,
        timeoutMs: TIMEOUT_MS,
      });
      const refusal = extractJsonObject<ExportPayload>({
        text: refused.stdout,
      });
      expect({
        that:
          refused.exitCode === 1 &&
          refusal?.error?.code === "E_PROJECT_RUNNING" &&
          // A short ID, never the name (which carries the project name).
          JSON.stringify(refusal.error.detail) ===
            JSON.stringify({ running: [standIn.stdout.trim().slice(0, 12)] }),
        message: "a running project container should refuse the export",
        result: refused,
      });
      expectExit({
        result: await docker(ctx, ["rm", "--force", runner]),
        codes: [0],
        message: "remove the stand-in project container",
      });

      // A short-lived writer that starts and exits while a copy helper runs:
      // no `docker ps` check can see it, the live event subscription does.
      // A large file keeps the copy window open long enough to aim at it.
      expectExit({
        result: await docker(ctx, [
          "run",
          "--rm",
          "--network",
          "none",
          "--volume",
          `${data}:/v`,
          "--entrypoint",
          "sh",
          HELPER,
          "-c",
          "head -c 268435456 /dev/zero >/v/big.bin",
        ]),
        codes: [0],
        message: "write a large file to widen the copy window",
      });
      const racing = ctx.cli({
        args: ["data", "export", "--json", "--out", out],
        cwd: fixture.root,
        timeoutMs: TIMEOUT_MS,
      });
      const helper = /^hack-data-export-[a-f0-9]{24}$/m;
      const writerCid = join(ctx.tempRoot, "writer.cid");
      let aimed = false;
      for (let attempt = 0; attempt < 600 && !aimed; attempt += 1) {
        const running = await docker(ctx, ["ps", "--format", "{{.Names}}"]);
        if (helper.test(running.stdout)) {
          expectExit({
            result: await docker(ctx, [
              "run",
              "--rm",
              "--name",
              writer,
              "--cidfile",
              writerCid,
              "--network",
              "none",
              "--volume",
              `${data}:/x`,
              "--entrypoint",
              "true",
              HELPER,
            ]),
            codes: [0],
            message: "the short-lived writer should run and exit",
          });
          aimed = true;
        } else {
          await Bun.sleep(25);
        }
      }
      const raced = await racing;
      const race = extractJsonObject<ExportPayload>({ text: raced.stdout });
      const mounts = (
        race?.error?.detail as { mounts?: { container: string }[] }
      )?.mounts;
      const writerId = aimed
        ? (await readFile(writerCid, "utf8")).trim().slice(0, 12)
        : "";
      expect({
        that:
          aimed &&
          raced.exitCode === 1 &&
          race?.error?.code === "E_PROJECT_RUNNING" &&
          writerId.length === 12 &&
          mounts?.some((mount) => mount.container === writerId) === true &&
          !raced.stdout.includes(writer),
        message:
          "a writer that started and exited during the copy should refuse publication",
        result: raced,
      });

      // Removed after every copy, right before the publish: Docker allows
      // the removal (a bind is no volume reference), so only the identity
      // recheck before the rename can refuse.
      await removedDuringExport({
        ctx,
        fixture,
        project,
        volume: data,
        stage: "before-publish",
      });
      for (const argv of [
        ["volume", "create", ...labels(project, "data"), data],
        [
          "run",
          "--rm",
          "--network",
          "none",
          "--volume",
          `${data}:/v`,
          "--entrypoint",
          "sh",
          HELPER,
          "-c",
          "echo again >/v/a.txt",
        ],
      ]) {
        expectExit({
          result: await docker(ctx, argv),
          codes: [0],
          message: `docker ${argv.slice(0, 2).join(" ")} should succeed`,
        });
      }
      await removedDuringExport({
        ctx,
        fixture,
        project,
        volume: data,
        stage: "before-hold",
      });
    } finally {
      await docker(ctx, ["rm", "--force", runner, writer]);
      await docker(ctx, ["volume", "rm", data, foreign, external, scratch]);
    }
  },
};

/**
 * The volume is removed during the export: export refuses and Docker
 * creates nothing, since the hold binds the Mountpoint and never mounts the
 * volume by name. A wrapper around the real engine removes the volume right
 * before the helper's create (`before-hold`), or after every copy, at the
 * last running check (`before-publish`), where only the identity recheck
 * before the rename can see it.
 */
async function removedDuringExport(opts: {
  readonly ctx: ScenarioContext;
  readonly fixture: MonorepoFixture;
  readonly project: string;
  readonly volume: string;
  readonly stage: "before-hold" | "before-publish";
}): Promise<void> {
  const { ctx, fixture, project } = opts;
  const data = opts.volume;
  const real = createHostDataBackupDocker({
    env: {},
    cwd: fixture.hackDir,
  });
  let removed = false;
  let copied = false;
  const at = (argv: readonly string[]): boolean =>
    opts.stage === "before-hold"
      ? argv[1] === "create" && argv.includes("--mount")
      : copied && argv[1] === "ps";
  const racingDocker: DataBackupDocker = {
    ...real,
    capture: async (argv, captureOpts) => {
      if (argv[1] === "exec") {
        copied = true;
      }
      if (!removed && at(argv)) {
        removed = true;
        expectExit({
          result: await docker(ctx, ["volume", "rm", data]),
          codes: [0],
          message: `remove the validated volume (${opts.stage})`,
        });
      }
      return await real.capture(argv, captureOpts);
    },
  };
  const outDir = join(ctx.tempRoot, `race-out-${opts.stage}`);
  let raceRefusal: unknown = null;
  try {
    await exportProjectData({
      docker: racingDocker,
      composeArgs: dataComposeArgs({
        composeFiles: [join(fixture.hackDir, "docker-compose.yml")],
        composeProject: null,
        cwd: fixture.hackDir,
        env: {},
      }),
      project,
      branch: null,
      hackHome: ctx.hackHome,
      outDir,
      hackVersion: "e2e",
    });
  } catch (error: unknown) {
    raceRefusal = error;
  }
  const listed = await docker(ctx, [
    "volume",
    "ls",
    "--quiet",
    "--filter",
    `name=^${data}$`,
  ]);
  // Nothing was published: at most the `.partial` directory is left.
  const leftInOut = await readdir(outDir).catch(() => [] as string[]);
  expect({
    that:
      removed &&
      raceRefusal instanceof HackCliError &&
      isRecord(raceRefusal.detail) &&
      raceRefusal.detail.reason === "volume_changed" &&
      listed.exitCode === 0 &&
      listed.stdout.trim() === "" &&
      leftInOut.every((entry) => entry.endsWith(".partial")),
    message: `a volume removed ${opts.stage} should refuse, publish nothing and not be recreated (raceRefusal: ${String(raceRefusal)}, listed: ${listed.stdout.trim()}, out: ${leftInOut.join(",")})`,
  });
}

function labels(project: string, key: string): string[] {
  return [
    "--label",
    `com.docker.compose.project=${project}`,
    "--label",
    `com.docker.compose.volume=${key}`,
  ];
}

async function docker(ctx: ScenarioContext, argv: readonly string[]) {
  return await runCommand({
    argv: ["docker", ...argv],
    cwd: ctx.tempRoot,
    timeoutMs: TIMEOUT_MS,
  });
}
