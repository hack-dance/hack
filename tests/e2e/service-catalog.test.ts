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
import { nativeSetupShellReply } from "../helpers/native-setup-inspection.ts";
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

    const runtime = join(root, "native-runtime");
    await writeFile(
      runtime,
      `#!/bin/sh
case "$1" in --internal-timings=*) shift;; esac
${nativeSetupShellReply()}
exit 99
`,
      { mode: 0o700 }
    );
    const start = (service: string) =>
      runCli({
        invocation: {
          args: ["up", "--detach", "--json", "--no-interactive", service],
          cwd: checkout,
          env: {
            HACK_RUNTIME_BACKEND: "native",
            HACK_NATIVE_BINARY: runtime,
          },
        },
        hackHome,
      });
    const missing = await start("missing");
    expect(missing.exitCode).toBe(1);
    expect(JSON.parse(missing.stdout).error).toMatchObject({
      code: "E_SERVICE_NOT_FOUND",
      message: "Unknown Compose service: missing.",
    });
    // The newly saved name passes selection and reaches source share admission.
    const savedTarget = await start("cache");
    expect(savedTarget.exitCode).toBe(1);
    expect(JSON.parse(savedTarget.stdout).error).toMatchObject({
      code: "E_PERMISSION",
      message: expect.stringContaining("requires HACK_NATIVE_SHARED_SOURCE=1"),
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
