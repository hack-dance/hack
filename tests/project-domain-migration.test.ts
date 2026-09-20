import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyProjectDomainMigration as apply,
  previewProjectDomainMigration as preview,
  rollbackProjectDomainMigration as rollback,
} from "../src/lib/project-domain-migration.ts";

const roots: string[] = [];
const config = '{"dev_host":"demo.hack", "custom":"preserve"}\n';
const compose =
  "# preserved\nservices:\n  web:\n    labels:\n      caddy: demo.hack\n";
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "domain-migration-"))
  );
  roots.push(root);
  await writeFile(join(root, "hack.config.json"), config, { mode: 0o640 });
  await writeFile(join(root, "docker-compose.yml"), compose, { mode: 0o600 });
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
test("preview has no effects; private journal restores exact bytes and modes", async () => {
  const projectDir = await fixture();
  const plan = await preview({ projectDir });
  expect(plan.toHost).toBe("demo.hack.local");
  expect(
    await lstat(join(projectDir, ".internal")).catch(() => null)
  ).toBeNull();
  await apply({ projectDir, plan });
  const journal = join(projectDir, ".internal/domain-migration");
  expect((await lstat(journal)).mode & 0o777).toBe(0o700);
  expect((await lstat(join(journal, "record.json"))).mode & 0o777).toBe(0o600);
  expect(await readFile(join(projectDir, "hack.config.json"), "utf8")).toBe(
    plan.configText
  );
  await expect(
    apply({ projectDir, plan: await preview({ projectDir }).catch(() => plan) })
  ).rejects.toThrow();
  await rollback({ projectDir });
  expect(await readFile(join(projectDir, "hack.config.json"), "utf8")).toBe(
    config
  );
  expect(await readFile(join(projectDir, "docker-compose.yml"), "utf8")).toBe(
    compose
  );
  expect((await lstat(join(projectDir, "hack.config.json"))).mode & 0o777).toBe(
    0o640
  );
  expect(
    (await lstat(join(projectDir, "docker-compose.yml"))).mode & 0o777
  ).toBe(0o600);
  expect(await lstat(journal).catch(() => null)).toBeNull();
});
test("stale previews refuse before journal or target writes", async () => {
  const projectDir = await fixture();
  const plan = await preview({ projectDir });
  await writeFile(join(projectDir, "hack.config.json"), `${config} `);
  await expect(apply({ projectDir, plan })).rejects.toThrow();
  expect(await readFile(join(projectDir, "docker-compose.yml"), "utf8")).toBe(
    compose
  );
  expect(
    await lstat(join(projectDir, ".internal/domain-migration")).catch(
      () => null
    )
  ).toBeNull();
});
test("rollback recovers mixed before/after state from interrupted application", async () => {
  const projectDir = await fixture();
  await apply({ projectDir, plan: await preview({ projectDir }) });
  await writeFile(join(projectDir, "docker-compose.yml"), compose);
  await rollback({ projectDir });
  expect(await readFile(join(projectDir, "hack.config.json"), "utf8")).toBe(
    config
  );
  expect(await readFile(join(projectDir, "docker-compose.yml"), "utf8")).toBe(
    compose
  );
});
test("rollback prechecks both files and refuses independent drift", async () => {
  const projectDir = await fixture();
  const plan = await preview({ projectDir });
  await apply({ projectDir, plan });
  await writeFile(join(projectDir, "docker-compose.yml"), "independent edit\n");
  await expect(rollback({ projectDir })).rejects.toThrow();
  expect(await readFile(join(projectDir, "hack.config.json"), "utf8")).toBe(
    plan.configText
  );
  expect(
    (
      await lstat(join(projectDir, ".internal/domain-migration/record.json"))
    ).isFile()
  ).toBe(true);
});
test("symlink directory, leaf and internal paths refuse", async () => {
  const projectDir = await fixture();
  await symlink(projectDir, join(projectDir, "alias"));
  await expect(
    preview({ projectDir: join(projectDir, "alias") })
  ).rejects.toThrow();
  const plan = await preview({ projectDir });
  await symlink(projectDir, join(projectDir, ".internal"));
  await expect(apply({ projectDir, plan })).rejects.toThrow();
  await rm(join(projectDir, "hack.config.json"));
  await symlink(
    join(projectDir, "docker-compose.yml"),
    join(projectDir, "hack.config.json")
  );
  await expect(preview({ projectDir })).rejects.toThrow();
});
test("oversized and nonregular files refuse", async () => {
  const projectDir = await fixture();
  await writeFile(
    join(projectDir, "hack.config.json"),
    "x".repeat(1024 * 1024 + 1)
  );
  await expect(preview({ projectDir })).rejects.toThrow();
  await rm(join(projectDir, "hack.config.json"));
  await mkdir(join(projectDir, "hack.config.json"));
  await expect(preview({ projectDir })).rejects.toThrow();
});
test("exclusive lock is never stolen and concurrent apply has one winner", async () => {
  const projectDir = await fixture();
  const plan = await preview({ projectDir });
  const lock = join(projectDir, ".internal/domain-migration.lock");
  await mkdir(lock, { recursive: true });
  await expect(apply({ projectDir, plan })).rejects.toThrow();
  expect((await lstat(lock)).isDirectory()).toBe(true);
  await rm(lock, { recursive: true });
  const results = await Promise.allSettled([
    apply({ projectDir, plan }),
    apply({ projectDir, plan }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled")
  ).toHaveLength(1);
  await rollback({ projectDir });
});
test("mode drift refuses rollback without touching the other file", async () => {
  const projectDir = await fixture();
  const plan = await preview({ projectDir });
  await apply({ projectDir, plan });
  await chmod(join(projectDir, "docker-compose.yml"), 0o644);
  await expect(rollback({ projectDir })).rejects.toThrow();
  expect(await readFile(join(projectDir, "hack.config.json"), "utf8")).toBe(
    plan.configText
  );
});

test("rollback recovers a published dead owner but refuses a live owner", async () => {
  const projectDir = await fixture();
  const plan = await preview({ projectDir });
  await apply({ projectDir, plan });
  const script = `
    const fs = require('node:fs');
    const path = require('node:path');
    const root = process.argv[1];
    const lock = path.join(root, '.internal/domain-migration.lock');
    fs.mkdirSync(lock, {mode: 0o700});
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({pid:process.pid}), {mode:0o600});
    fs.writeFileSync(path.join(root, 'docker-compose.yml'), ${JSON.stringify(compose)});
    console.log('ready');
    setInterval(() => {}, 1000);
  `;
  const child = Bun.spawn([process.execPath, "-e", script, projectDir], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      "ready\n"
    );
    reader.releaseLock();
    await expect(rollback({ projectDir })).rejects.toThrow();
    expect(await readFile(join(projectDir, "hack.config.json"), "utf8")).toBe(
      plan.configText
    );
    child.kill("SIGKILL");
    await child.exited;
    const competing = await Promise.allSettled([
      rollback({ projectDir }),
      rollback({ projectDir }),
    ]);
    expect(
      competing.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(await readFile(join(projectDir, "hack.config.json"), "utf8")).toBe(
      config
    );
    expect(await readFile(join(projectDir, "docker-compose.yml"), "utf8")).toBe(
      compose
    );
    expect(
      await lstat(join(projectDir, ".internal/domain-migration.lock")).catch(
        () => null
      )
    ).toBeNull();
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL");
    await child.exited;
  }
});

test("rollback refuses malformed unpublished lock ownership", async () => {
  const projectDir = await fixture();
  await apply({ projectDir, plan: await preview({ projectDir }) });
  const lock = join(projectDir, ".internal/domain-migration.lock");
  await mkdir(lock, { mode: 0o700 });
  await expect(rollback({ projectDir })).rejects.toThrow();
  await writeFile(join(lock, "owner.json"), '{"pid":0}', { mode: 0o600 });
  await expect(rollback({ projectDir })).rejects.toThrow();
  expect((await lstat(lock)).isDirectory()).toBe(true);
});

test("journal and interrupted staging remain Git ignored without parent rules", async () => {
  const projectDir = await fixture();
  const git = async (args: string[]) => {
    const child = Bun.spawn(["git", "-C", projectDir, ...args], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return output;
  };
  await git(["init", "--quiet"]);
  await apply({ projectDir, plan: await preview({ projectDir }) });
  const prefix = ".internal/domain-migration/";
  const residue = `${prefix}staging/write-${"a".repeat(24)}.tmp`;
  await writeFile(join(projectDir, residue), "synthetic private residue", {
    mode: 0o600,
  });
  const paths = [`${prefix}record.json`, `${prefix}.gitignore`, residue];
  expect(
    (await git(["check-ignore", "--", ...paths])).trim().split("\n")
  ).toEqual(paths);
  await git(["add", "."]);
  expect(await git(["ls-files", "--", `${prefix}*`])).toBe("");
  await rollback({ projectDir });
  expect(await lstat(join(projectDir, prefix)).catch(() => null)).toBeNull();
});

test("rollback refuses altered ignore rule and foreign staging entries", async () => {
  const projectDir = await fixture();
  const plan = await preview({ projectDir });
  await apply({ projectDir, plan });
  const journal = join(projectDir, ".internal/domain-migration");
  await writeFile(join(journal, ".gitignore"), "record.json\n");
  await expect(rollback({ projectDir })).rejects.toThrow();
  await writeFile(join(journal, ".gitignore"), "*\n");
  await writeFile(join(journal, "staging", "foreign"), "public");
  await expect(rollback({ projectDir })).rejects.toThrow();
  expect(await readFile(join(projectDir, "hack.config.json"), "utf8")).toBe(
    plan.configText
  );
});
