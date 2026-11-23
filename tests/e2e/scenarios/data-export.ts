import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { DATA_BACKUP_DIGEST_SCRIPT } from "../../../src/lib/data-backup-format.ts";
import { createMonorepoFixture } from "../fixture.ts";
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
      readonly composeProject?: string;
      readonly helperImage?: string;
      readonly volumes?: readonly {
        readonly key: string;
        readonly name: string;
        readonly file: string;
        readonly tarBytes: number;
        readonly tarSha256: string;
        readonly entries: number;
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
          "echo one >/v/a.txt && ln -s a.txt /v/link && mkdir /v/d && echo two >/v/d/secret && chown 1234:5678 /v/d/secret && chmod 0640 /v/d/secret",
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
          manifest.composeProject === project &&
          manifest.helperImage === HELPER &&
          manifest.volumes?.length === 1 &&
          volume?.key === "data" &&
          volume.name === data &&
          volume.entries === 5 &&
          JSON.stringify(manifest.skipped) ===
            JSON.stringify([
              { key: "other", name: foreign, reason: "foreign" },
              { key: "shared", name: external, reason: "external" },
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
          JSON.parse(digest.stdout).digest === volume?.contentDigest,
        message: "a restored tree should have the recorded content digest",
        result: digest,
      });

      expectExit({
        result: await docker(ctx, [
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
        ]),
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
          JSON.stringify(refusal.error.detail) ===
            JSON.stringify({ running: [runner] }),
        message: "a running project container should refuse the export",
        result: refused,
      });
    } finally {
      await docker(ctx, ["rm", "--force", runner]);
      await docker(ctx, ["volume", "rm", data, foreign, external, scratch]);
    }
  },
};

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
