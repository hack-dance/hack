import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseLaunchctlGuard, runCli } from "./harness.ts";

test("service add previews and updates a Compose file on the native backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-catalog-e2e-"));
  const hackHome = join(root, "home");
  const checkout = join(root, "checkout");
  const dir = join(checkout, ".dev");
  const file = join(dir, "docker-compose.yml");
  const source =
    "# project services\nservices:\n  web: { image: 'example/web' } # keep\n";
  try {
    await mkdir(hackHome);
    await mkdir(dir, { recursive: true });
    await writeFile(file, source);
    const cli = (extra: string[]) =>
      runCli({
        invocation: {
          args: [
            "service",
            "add",
            "redis",
            "--name",
            "cache",
            "--json",
            ...extra,
          ],
          cwd: checkout,
          env: { HACK_RUNTIME_BACKEND: "native" },
        },
        hackHome,
      });
    const dryRun = await cli(["--dry-run"]);
    expect(dryRun.exitCode).toBe(0);
    const { data } = JSON.parse(dryRun.stdout);
    expect(data).toMatchObject({
      schema: "hack.service-add.v1",
      file: ".dev/docker-compose.yml",
      service: "cache",
      saved: false,
    });
    expect(data.diff).toContain('+  "cache":');
    expect(await readFile(file, "utf8")).toBe(source);
    expect(await readdir(dir)).toEqual(["docker-compose.yml"]);

    const changed = `# edited after preview\n${source}`;
    await writeFile(file, changed);
    const stale = await cli(["--expect-revision", data.revision]);
    expect(stale.exitCode).not.toBe(0);
    expect(JSON.parse(stale.stdout).error.code).toBe("E_REQUEST_CONFLICT");
    expect(await readFile(file, "utf8")).toBe(changed);

    await writeFile(file, source);
    const save = await cli(["--expect-revision", data.revision]);
    expect(save.exitCode).toBe(0);
    expect(JSON.parse(save.stdout).data.saved).toBe(true);
    const saved = `${source}  "cache":\n    image: redis:7-alpine\n    volumes:\n      - cache-data:/data\nvolumes:\n  cache-data: {}\n`;
    expect(await readFile(file, "utf8")).toBe(saved);

    const start = await runCli({
      invocation: {
        args: ["up", "--detach", "--json", "cache"],
        cwd: checkout,
        env: {
          HACK_RUNTIME_BACKEND: "native",
          HACK_NATIVE_BINARY: join(root, "must-not-run"),
        },
      },
      hackHome,
    });
    expect(start.exitCode).not.toBe(0);
    expect(JSON.parse(start.stdout).error).toMatchObject({
      code: "E_USAGE",
      message: expect.stringContaining("service selection is not supported"),
    });

    const duplicate = await cli([]);
    expect(duplicate.exitCode).not.toBe(0);
    expect(JSON.parse(duplicate.stdout).error.code).toBe("E_PATH_CONFLICT");
    expect(await readFile(file, "utf8")).toBe(saved);
  } finally {
    releaseLaunchctlGuard();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("authored native projects receive catalog guidance without a write", async () => {
  const root = await mkdtemp(join(tmpdir(), "hack-catalog-authored-"));
  const hackHome = join(root, "home");
  const checkout = join(root, "checkout");
  const dir = join(checkout, ".hack");
  try {
    await mkdir(hackHome);
    await mkdir(dir, { recursive: true });
    const file = join(dir, "hack.project.json");
    await writeFile(file, "{}\n");
    const result = await runCli({
      invocation: {
        args: ["service", "add", "redis", "--json"],
        cwd: checkout,
        env: { HACK_RUNTIME_BACKEND: "native" },
      },
      hackHome,
    });
    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse(result.stdout).error).toMatchObject({
      code: "E_NATIVE_PROJECT_UNSUPPORTED",
      message: expect.stringContaining("Add the service to its workloads"),
    });
    expect(await readdir(dir)).toEqual(["hack.project.json"]);
    expect(await readFile(file, "utf8")).toBe("{}\n");
  } finally {
    releaseLaunchctlGuard();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
