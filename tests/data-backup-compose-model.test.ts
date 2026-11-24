import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataComposeArgs } from "../src/commands/data.ts";
import { createHostDataBackupDocker } from "../src/lib/data-backup-docker.ts";
import { parseJsonText } from "../src/lib/data-backup-helper.ts";
import { planDeclaredVolumes } from "../src/lib/data-backup-volumes.ts";
import { spawnSyncBounded } from "./helpers/bounded-spawn-sync.ts";

/**
 * `hack data` reads the instance's model as `hack up` resolves it: every
 * Compose file of the stack, the managed env and all profiles. Runs the real
 * `docker compose config`, which needs the Compose plugin but no engine.
 */
const composeAvailable = (() => {
  try {
    return (
      spawnSyncBounded(["docker", "compose", "version", "--short"], {
        timeout: 20_000,
      }).exitCode === 0
    );
  } catch {
    return false;
  }
})();

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-data-model-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("the argv carries every stack file in order and enables all profiles", () => {
  const argv = dataComposeArgs({
    composeFiles: [
      "/p/.hack/docker-compose.yml",
      "/h/internal.yml",
      "/p/env.yml",
    ],
    composeProject: "shop--feature",
    cwd: "/p/.hack",
    env: {},
  });
  expect(argv).toEqual([
    "docker",
    "compose",
    "-p",
    "shop--feature",
    "--project-directory",
    "/p/.hack",
    "-f",
    "/p/.hack/docker-compose.yml",
    "-f",
    "/h/internal.yml",
    "-f",
    "/p/env.yml",
    "--profile",
    "*",
  ]);
});

test.skipIf(!composeAvailable)(
  "an override's volume, a profile-gated service's volume and a managed-env name are all declared",
  async () => {
    const base = join(root, "docker-compose.yml");
    const override = join(root, "override.yml");
    await writeFile(
      base,
      [
        "name: shop",
        "services:",
        "  web:",
        "    image: busybox",
        "    volumes: [data:/data]",
        "  worker:",
        "    image: busybox",
        "    profiles: [jobs]",
        "    volumes: [jobs:/jobs]",
        "volumes:",
        "  data:",
        "    name: shop_data-${DATA_SUFFIX}",
        "  jobs: {}",
        "",
      ].join("\n")
    );
    await writeFile(
      override,
      [
        "services:",
        "  web:",
        "    volumes: [cache:/cache]",
        "volumes:",
        "  cache: {}",
        "",
      ].join("\n")
    );
    const model = {
      composeFiles: [base, override],
      composeProject: null,
      cwd: root,
      env: { DATA_SUFFIX: "managed" },
    };
    const docker = createHostDataBackupDocker({
      env: model.env,
      cwd: model.cwd,
    });
    const config = await docker.capture([
      ...dataComposeArgs(model),
      "config",
      "--format",
      "json",
    ]);
    expect(config.exitCode).toBe(0);
    const plan = planDeclaredVolumes(parseJsonText(config.stdout));
    expect(plan.declared.map((volume) => [volume.key, volume.name])).toEqual([
      ["cache", "shop_cache"],
      ["data", "shop_data-managed"],
      ["jobs", "shop_jobs"],
    ]);
  }
);
