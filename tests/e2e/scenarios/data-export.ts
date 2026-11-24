import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dataComposeArgs } from "../../../src/commands/data.ts";
import { HackCliError } from "../../../src/lib/cli-result.ts";
import {
  createHostDataBackupDocker,
  type DataBackupDocker,
} from "../../../src/lib/data-backup-docker.ts";
import {
  type DataExportResult,
  exportProjectData,
} from "../../../src/lib/data-backup-export.ts";
import {
  DATA_BACKUP_ARCHIVE_DIGEST_SCRIPT,
  DATA_BACKUP_DIGEST_SCRIPT,
} from "../../../src/lib/data-backup-format.ts";
import {
  dataCleanupRecordPath,
  endpointDigest,
  engineSource,
  writeDataCleanupRecord,
} from "../../../src/lib/data-cleanup-record.ts";
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
    // Container names that carry a value, as `container_name:
    // worker-${STORAGE_TOKEN}` would: no refusal may print them. Not a
    // credential, a recognizable canary.
    const token = "storage-token-canary-e2e";
    const runner = `${project}-worker-${token}`;
    const scratch = `${project}-restore`;
    const writer = `${project}-writer-${token}`;
    const holder = `${project}-bind-holder-${token}`;
    const alias = `${project}-alias-${token}`;
    const aliasWriter = `${project}-alias-writer-${token}`;
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
            JSON.stringify({ running: [standIn.stdout.trim().slice(0, 12)] }) &&
          !refused.stdout.includes(token),
        message: "a running project container should refuse the export",
        result: refused,
      });
      expectExit({
        result: await docker(ctx, ["rm", "--force", runner]),
        codes: [0],
        message: "remove the stand-in project container",
      });
      await bindHolderRefuses({ ctx, fixture, out, volume: data, holder });
      await aliasWriterRefuses({
        ctx,
        fixture,
        out,
        volume: data,
        alias,
        holder: aliasWriter,
      });
      // The same alias spelled through /proc/self/root: text shows no
      // overlap, the daemon-side proof does.
      await aliasWriterRefuses({
        ctx,
        fixture,
        out,
        volume: data,
        alias,
        holder: aliasWriter,
        devicePrefix: "/proc/self/root",
      });
      await unrelatedBindPublishes({ ctx, fixture, holder: aliasWriter });

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
          !raced.stdout.includes(token),
        message:
          "a writer that started and exited during the copy should refuse publication",
        result: raced,
      });

      // During the copy Hack holds a Docker reference to the volume: its
      // removal is refused and the export completes with the right digest.
      await removalRefusedDuringCopy({ ctx, fixture, project, volume: data });
      await cleanupRemovesLabeledHelper({
        ctx,
        fixture,
        project,
        volume: data,
      });
      await replacedWithinOneSecond({ ctx, fixture, project, volume: data });
      await recreateVolume({ ctx, project, volume: data });
      await removedBeforeReference({ ctx, fixture, project, volume: data });
    } finally {
      await docker(ctx, ["rm", "--force", runner, writer, holder, aliasWriter]);
      await docker(ctx, ["volume", "rm", alias]);
      await docker(ctx, ["volume", "rm", data, foreign, external, scratch]);
    }
  },
};

/** Export through a wrapper around the real engine that `before` sees. */
async function exportThrough(opts: {
  readonly ctx: ScenarioContext;
  readonly fixture: MonorepoFixture;
  readonly project: string;
  readonly outDir: string;
  readonly before: (argv: readonly string[]) => Promise<void>;
}): Promise<{ result: DataExportResult | null; refusal: unknown }> {
  const real = createHostDataBackupDocker({
    env: {},
    cwd: opts.fixture.hackDir,
  });
  const racing: DataBackupDocker = {
    ...real,
    capture: async (argv, captureOpts) => {
      await opts.before(argv);
      return await real.capture(argv, captureOpts);
    },
  };
  try {
    const result = await exportProjectData({
      docker: racing,
      composeArgs: dataComposeArgs({
        composeFiles: [join(opts.fixture.hackDir, "docker-compose.yml")],
        composeProject: null,
        cwd: opts.fixture.hackDir,
        env: {},
      }),
      project: opts.project,
      branch: null,
      hackHome: opts.ctx.hackHome,
      outDir: opts.outDir,
      hackVersion: "e2e",
    });
    return { result, refusal: null };
  } catch (error: unknown) {
    return { result: null, refusal: error };
  }
}

/**
 * `docker volume rm` while the copy reads the volume through its bind:
 * Hack's reference container (created, never started) makes Docker refuse
 * the removal ("volume is in use"), and the export completes with the
 * content digest of the volume's real tree.
 */
async function removalRefusedDuringCopy(opts: {
  readonly ctx: ScenarioContext;
  readonly fixture: MonorepoFixture;
  readonly project: string;
  readonly volume: string;
}): Promise<void> {
  const { ctx } = opts;
  let removal: Awaited<ReturnType<typeof docker>> | null = null;
  const { result, refusal } = await exportThrough({
    ...opts,
    outDir: join(ctx.tempRoot, "removal-refused-out"),
    before: async (argv) => {
      if (removal === null && argv[1] === "exec") {
        removal = await docker(ctx, ["volume", "rm", opts.volume]);
      }
    },
  });
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
    `${opts.volume}:/v:ro`,
    "--entrypoint",
    "bun",
    HELPER,
    "-e",
    DATA_BACKUP_DIGEST_SCRIPT,
  ]);
  const refused = removal as Awaited<ReturnType<typeof docker>> | null;
  expect({
    that:
      refused !== null &&
      refused.exitCode !== 0 &&
      /in use/i.test(refused.stderr) &&
      refusal === null &&
      result !== null &&
      digest.exitCode === 0 &&
      JSON.parse(digest.stdout).digest ===
        result.manifest.volumes[0]?.contentDigest,
    message: `a volume removal during the copy should be refused and the export complete with the volume's digest (removal: ${refused?.exitCode} ${refused?.stderr.trim()}, refusal: ${String(refusal)})`,
  });
}

/**
 * The volume is removed after validation, right before Hack creates its
 * reference. The reference names local driver options Docker uses only to
 * create a volume and refuses to create with, so the missing name is
 * refused rather than recreated: export refuses, publishes nothing, and no
 * volume of that name exists afterwards (read-only).
 */
async function removedBeforeReference(opts: {
  readonly ctx: ScenarioContext;
  readonly fixture: MonorepoFixture;
  readonly project: string;
  readonly volume: string;
}): Promise<void> {
  const { ctx } = opts;
  const createdAt = async (): Promise<string> =>
    (
      await docker(ctx, [
        "volume",
        "inspect",
        "--format",
        "{{.CreatedAt}}",
        opts.volume,
      ])
    ).stdout.trim();
  let before = "";
  const outDir = join(ctx.tempRoot, "removed-before-reference-out");
  const { refusal } = await exportThrough({
    ...opts,
    outDir,
    before: async (argv) => {
      // Right before Hack's reference is created: after every check.
      if (
        before === "" &&
        argv[1] === "create" &&
        argv.some((arg) => arg.startsWith("type=volume,"))
      ) {
        before = await createdAt();
        expectExit({
          result: await docker(ctx, ["volume", "rm", opts.volume]),
          codes: [0],
          message: "remove the validated volume before the reference",
        });
      }
    },
  });
  const after = await createdAt();
  const leftInOut = await readdir(outDir).catch(() => [] as string[]);
  expect({
    that:
      before !== "" &&
      refusal instanceof HackCliError &&
      isRecord(refusal.detail) &&
      refusal.detail.reason === "volume_changed" &&
      // Nothing recreated it: no volume of that name exists.
      after === "" &&
      leftInOut.every((entry) => entry.endsWith(".partial")),
    message: `a volume removed before the reference should refuse and publish nothing (refusal: ${String(refusal)}, CreatedAt before/after: ${before}/${after}, out: ${leftInOut.join(",")})`,
  });
}

/**
 * The volume is removed and created again under its name, with the same
 * labels, between validation and Hack's reference, within the same second as its
 * validated creation where the host allows: the hold then binds the new
 * volume's directory (a local volume's Mountpoint is its name's path) and
 * every identity field matches, so only Docker's destroy/create events can
 * refuse. A wrapper creates the volume just after a second boundary right
 * before export validates it, and replaces it at the first running check. Up to
 * three attempts aim for one second; every attempt must refuse.
 */
async function replacedWithinOneSecond(opts: {
  readonly ctx: ScenarioContext;
  readonly fixture: MonorepoFixture;
  readonly project: string;
  readonly volume: string;
}): Promise<void> {
  const { ctx, fixture, project, volume } = opts;
  const create = ["volume", "create", ...labels(project, "data"), volume];
  const createdAt = async (): Promise<string> =>
    (
      await docker(ctx, [
        "volume",
        "inspect",
        "--format",
        "{{.CreatedAt}}",
        volume,
      ])
    ).stdout.trim();
  const pairs: string[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await docker(ctx, ["volume", "rm", volume]);
    const real = createHostDataBackupDocker({ env: {}, cwd: fixture.hackDir });
    let validated = "";
    let replaced = "";
    const racing: DataBackupDocker = {
      ...real,
      capture: async (argv, captureOpts) => {
        if (
          validated === "" &&
          argv[1] === "volume" &&
          argv.at(-1) === volume
        ) {
          await Bun.sleep(1005 - (Date.now() % 1000));
          expectExit({
            result: await docker(ctx, create),
            codes: [0],
            message: "create the volume right before validation",
          });
          validated = await createdAt();
        }
        // At the first running check: after validation, before Hack's
        // reference (which would refuse the removal) exists.
        if (replaced === "" && validated !== "" && argv[1] === "ps") {
          expectExit({
            result: await docker(ctx, ["volume", "rm", volume]),
            codes: [0],
            message: "remove the validated volume",
          });
          expectExit({
            result: await docker(ctx, create),
            codes: [0],
            message: "create it again under its name",
          });
          replaced = await createdAt();
        }
        return await real.capture(argv, captureOpts);
      },
    };
    const refusal = await exportProjectData({
      docker: racing,
      composeArgs: dataComposeArgs({
        composeFiles: [join(fixture.hackDir, "docker-compose.yml")],
        composeProject: null,
        cwd: fixture.hackDir,
        env: {},
      }),
      project,
      branch: null,
      hackHome: ctx.hackHome,
      outDir: join(ctx.tempRoot, `replaced-out-${attempt}`),
      hackVersion: "e2e",
    }).then(
      () => null,
      (error: unknown) => error
    );
    pairs.push(`${validated}/${replaced}`);
    expect({
      that:
        replaced !== "" &&
        refusal instanceof HackCliError &&
        isRecord(refusal.detail) &&
        refusal.detail.reason === "volume_changed",
      message: `a volume replaced under its name before the hold should refuse (attempt ${attempt}, CreatedAt validated/replaced: ${validated}/${replaced}, refusal: ${String(refusal)})`,
    });
    if (validated === replaced) {
      break;
    }
  }
  // Which identity the replacement had, for the report.
  console.log(
    `replaced-within-one-second CreatedAt validated/replaced: ${pairs.join(", ")}`
  );
  await docker(ctx, ["volume", "rm", volume]);
}

/** Create the `data` volume again, with Compose's labels and one file. */
async function recreateVolume(opts: {
  readonly ctx: ScenarioContext;
  readonly project: string;
  readonly volume: string;
}): Promise<void> {
  for (const argv of [
    ["volume", "create", ...labels(opts.project, "data"), opts.volume],
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--volume",
      `${opts.volume}:/v`,
      "--entrypoint",
      "sh",
      HELPER,
      "-c",
      "echo again >/v/a.txt",
    ],
  ]) {
    expectExit({
      result: await docker(opts.ctx, argv),
      codes: [0],
      message: `docker ${argv.slice(0, 2).join(" ")} should succeed`,
    });
  }
}

/**
 * A container already running with a read-only bind of the volume's
 * Mountpoint (Hack's own hold technique) is not found by
 * `docker ps --filter volume=`; the inspection of every running container
 * refuses the export, naming it by short ID.
 */
async function bindHolderRefuses(opts: {
  readonly ctx: ScenarioContext;
  readonly fixture: MonorepoFixture;
  readonly out: string;
  readonly volume: string;
  readonly holder: string;
}): Promise<void> {
  const { ctx } = opts;
  const mountpoint = await docker(ctx, [
    "volume",
    "inspect",
    "--format",
    "{{.Mountpoint}}",
    opts.volume,
  ]);
  const started = await docker(ctx, [
    "run",
    "--detach",
    "--network",
    "none",
    "--name",
    opts.holder,
    "--mount",
    `type=bind,src=${mountpoint.stdout.trim()},dst=/x,readonly`,
    "--entrypoint",
    "sleep",
    HELPER,
    "300",
  ]);
  expectExit({
    result: started,
    codes: [0],
    message: "a container binding the volume's Mountpoint should start",
  });
  const refused = await ctx.cli({
    args: ["data", "export", "--json", "--out", opts.out],
    cwd: opts.fixture.root,
    timeoutMs: TIMEOUT_MS,
  });
  const refusal = extractJsonObject<ExportPayload>({ text: refused.stdout });
  expect({
    that:
      refused.exitCode === 1 &&
      refusal?.error?.code === "E_PROJECT_RUNNING" &&
      JSON.stringify(refusal.error.detail) ===
        JSON.stringify({ running: [started.stdout.trim().slice(0, 12)] }) &&
      !refused.stdout.includes(opts.holder),
    message: "a running container binding the Mountpoint should refuse",
    result: refused,
  });
  expectExit({
    result: await docker(ctx, ["rm", "--force", opts.holder]),
    codes: [0],
    message: "remove the bind holder",
  });
}

/**
 * A foreign local volume whose options bind the owned volume's Mountpoint
 * (`--opt type=none --opt o=bind --opt device=<Mountpoint>`) aliases its
 * storage; a container mounting it shows only the alias's own Name and
 * Source. Export inspects the alias's backing and refuses, by short ID,
 * printing neither name.
 */
async function aliasWriterRefuses(opts: {
  readonly ctx: ScenarioContext;
  readonly fixture: MonorepoFixture;
  readonly out: string;
  readonly volume: string;
  readonly alias: string;
  readonly holder: string;
  /** Prepended to the device path (it still names the Mountpoint). */
  readonly devicePrefix?: string;
}): Promise<void> {
  const { ctx } = opts;
  const mountpoint = (
    await docker(ctx, [
      "volume",
      "inspect",
      "--format",
      "{{.Mountpoint}}",
      opts.volume,
    ])
  ).stdout.trim();
  expectExit({
    result: await docker(ctx, [
      "volume",
      "create",
      "--opt",
      "type=none",
      "--opt",
      "o=bind",
      "--opt",
      `device=${opts.devicePrefix ?? ""}${mountpoint}`,
      opts.alias,
    ]),
    codes: [0],
    message: "create a local volume aliasing the owned Mountpoint",
  });
  const started = await docker(ctx, [
    "run",
    "--detach",
    "--network",
    "none",
    "--name",
    opts.holder,
    "--volume",
    `${opts.alias}:/data`,
    "--entrypoint",
    "sleep",
    HELPER,
    "300",
  ]);
  expectExit({
    result: started,
    codes: [0],
    message: "a container mounting the alias should start",
  });
  const refused = await ctx.cli({
    args: ["data", "export", "--json", "--out", opts.out],
    cwd: opts.fixture.root,
    timeoutMs: TIMEOUT_MS,
  });
  const refusal = extractJsonObject<ExportPayload>({ text: refused.stdout });
  expect({
    that:
      refused.exitCode === 1 &&
      refusal?.error?.code === "E_PROJECT_RUNNING" &&
      JSON.stringify(refusal.error.detail) ===
        JSON.stringify({ running: [started.stdout.trim().slice(0, 12)] }) &&
      !refused.stdout.includes(opts.alias) &&
      !refused.stdout.includes(opts.holder),
    message: `a running container writing through an alias volume (device prefix: ${opts.devicePrefix ?? "none"}) should refuse`,
    result: refused,
  });
  expectExit({
    result: await docker(ctx, ["rm", "--force", opts.holder]),
    codes: [0],
    message: "remove the alias writer",
  });
  expectExit({
    result: await docker(ctx, ["volume", "rm", opts.alias]),
    codes: [0],
    message: "remove the alias volume",
  });
}

/**
 * A running container that binds a directory separate from every copied
 * volume: text cannot settle it, so the daemon-side proof runs, finds it
 * separate, and the export publishes.
 */
async function unrelatedBindPublishes(opts: {
  readonly ctx: ScenarioContext;
  readonly fixture: MonorepoFixture;
  readonly holder: string;
}): Promise<void> {
  const { ctx } = opts;
  expectExit({
    result: await docker(ctx, [
      "run",
      "--detach",
      "--network",
      "none",
      "--name",
      opts.holder,
      "--mount",
      `type=bind,src=${opts.fixture.hackDir},dst=/src,readonly`,
      "--entrypoint",
      "sleep",
      HELPER,
      "300",
    ]),
    codes: [0],
    message: "a container with an unrelated bind should start",
  });
  const exported = await ctx.cli({
    args: [
      "data",
      "export",
      "--json",
      "--out",
      join(ctx.tempRoot, "unrelated-bind-out"),
    ],
    cwd: opts.fixture.root,
    timeoutMs: TIMEOUT_MS,
  });
  const payload = extractJsonObject<ExportPayload>({ text: exported.stdout });
  expect({
    that:
      exported.exitCode === 0 && payload?.data?.manifest?.volumes?.length === 1,
    message: "an unrelated bind should be proven separate and publish",
    result: exported,
  });
  expectExit({
    result: await docker(ctx, ["rm", "--force", opts.holder]),
    codes: [0],
    message: "remove the unrelated bind container",
  });
}

/**
 * A helper left behind under a nonce (as after a create whose outcome Hack
 * could not reconcile), referencing the volume: `hack data cleanup --nonce`
 * removes exactly it, by ID, and the volume stays.
 */
async function cleanupRemovesLabeledHelper(opts: {
  readonly ctx: ScenarioContext;
  readonly fixture: MonorepoFixture;
  readonly project: string;
  readonly volume: string;
}): Promise<void> {
  const { ctx } = opts;
  const nonce = new Bun.CryptoHasher("sha256")
    .update(`${ctx.tempRoot}-cleanup`)
    .digest("hex")
    .slice(0, 32);
  // A nonce with no record: cleanup refuses and touches nothing.
  const unrecorded = new Bun.CryptoHasher("sha256")
    .update(`${ctx.tempRoot}-unrecorded`)
    .digest("hex")
    .slice(0, 32);
  const refused = await ctx.cli({
    args: ["data", "cleanup", "--nonce", unrecorded, "--json"],
    cwd: opts.fixture.root,
    timeoutMs: TIMEOUT_MS,
  });
  expect({
    that:
      refused.exitCode !== 0 &&
      extractJsonObject<{ error?: { code?: string } }>({ text: refused.stdout })
        ?.error?.code === "E_DATA_CLEANUP_RECORD",
    message: "a nonce without a cleanup record should refuse",
    result: refused,
  });
  // The run's record, as export writes it before its first create.
  const docker = createHostDataBackupDocker({
    env: {},
    cwd: opts.fixture.hackDir,
  });
  await writeDataCleanupRecord({
    hackHome: ctx.hackHome,
    record: {
      version: 1,
      nonce,
      command: "export",
      project: opts.project,
      branch: null,
      envName: null,
      envDefault: true,
      engine: engineSource({ docker, envName: null }),
      endpointSha256: await endpointDigest(docker),
      createdAt: new Date().toISOString(),
    },
  });
  const left = await dockerCli(ctx, [
    "create",
    "--network",
    "none",
    "--label",
    `io.hack.data-backup.nonce=${nonce}`,
    "--mount",
    `type=volume,src=${opts.volume},dst=/v,volume-nocopy`,
    "--entrypoint",
    "true",
    HELPER,
  ]);
  expectExit({
    result: left,
    codes: [0],
    message: "leave a labeled helper behind",
  });
  const id = left.stdout.trim();
  const cleaned = await ctx.cli({
    args: ["data", "cleanup", "--nonce", nonce, "--json"],
    cwd: opts.fixture.root,
    timeoutMs: TIMEOUT_MS,
  });
  const payload = extractJsonObject<{
    data?: { schema?: string; removed?: string[] };
  }>({ text: cleaned.stdout });
  const gone = await dockerCli(ctx, ["container", "inspect", id]);
  const kept = await dockerCli(ctx, ["volume", "inspect", opts.volume]);
  const record = await readFile(
    dataCleanupRecordPath({ hackHome: ctx.hackHome, nonce }),
    "utf8"
  ).catch(() => null);
  expect({
    that:
      cleaned.exitCode === 0 &&
      payload?.data?.schema === "hack.data-cleanup.v1" &&
      JSON.stringify(payload.data.removed) === JSON.stringify([id]) &&
      gone.exitCode !== 0 &&
      kept.exitCode === 0 &&
      record === null,
    message:
      "hack data cleanup should remove the labeled helper by ID, keep the volume and remove the record",
    result: cleaned,
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

const dockerCli = (ctx: ScenarioContext, argv: readonly string[]) =>
  docker(ctx, argv);

async function docker(ctx: ScenarioContext, argv: readonly string[]) {
  return await runCommand({
    argv: ["docker", ...argv],
    cwd: ctx.tempRoot,
    timeoutMs: TIMEOUT_MS,
  });
}
