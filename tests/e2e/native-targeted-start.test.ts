import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { loadNativeProjectRun } from "../../src/backends/native-project-run.ts";
import { isRecord } from "../../src/lib/guards.ts";
import { privateCliEnv } from "../helpers/private-cli-env.ts";

const cli = process.env.HACK_TARGETED_TEST_CLI;
const runtime = process.env.HACK_LOCAL_TEST_BINARY;
const nativeHome = process.env.HACK_LOCAL_TEST_ROOT;
const image = process.env.HACK_LOCAL_TEST_IMAGE;

/**
 * Run explicitly with a matching compiled Hack CLI and an isolated, ready
 * macOS development pool with a pinned shell image already available.
 */
test.skipIf(
  process.platform !== "darwin" || !(cli && runtime && nativeHome && image)
)(
  "native CLI exec and retained-data restore work after partial up and plain up with shared source",
  async () => {
    if (
      !(
        cli &&
        isAbsolute(cli) &&
        runtime &&
        isAbsolute(runtime) &&
        nativeHome &&
        isAbsolute(nativeHome) &&
        image &&
        /^sha256:[a-f0-9]{64}$/.test(image)
      )
    ) {
      throw new Error(
        "Select absolute fixture executables and a pinned fixture image"
      );
    }
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "native-targeted-restore-"))
    );
    const projectRoot = join(root, "project");
    const projectDir = join(projectRoot, ".hack");
    await mkdir(projectDir, { recursive: true, mode: 0o700 });
    const scope = { projectRoot, projectDir, nativeHome, branch: null };
    const composeFile = join(projectDir, "docker-compose.yml");
    await writeFile(
      join(projectDir, "hack.config.json"),
      JSON.stringify({ name: "targeted-restore-fixture" })
    );
    const service = (volume: string) => ({
      image,
      network_mode: "none",
      user: "0:0",
      entrypoint: ["/bin/sleep", "300"],
      command: [],
      volumes: [`${volume}:/data`],
      stop_grace_period: "1s",
    });
    const web = {
      ...service("zdata"),
      volumes: ["zdata:/data", "../src:/app:ro"],
    };
    const redis = service("adata");
    const env = privateCliEnv({
      root,
      env: {
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_BINARY: runtime,
        HACK_NATIVE_HOME: nativeHome,
        HACK_NATIVE_SHARED_SOURCE: "1",
        HACK_NO_INTERACTIVE: "1",
      },
    });
    const invoke = async (argv: readonly string[]) => {
      const child = Bun.spawn([...argv], {
        cwd: projectRoot,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120_000,
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stderr).toBe(0);
      return stdout;
    };
    const command = async (argv: readonly string[]) => {
      const stdout = await invoke(argv);
      const reply: unknown = JSON.parse(stdout);
      if (!isRecord(reply)) {
        throw new Error("Expected a fixture JSON reply");
      }
      return reply;
    };
    const hack = (...args: string[]) =>
      command([
        cli,
        "--path",
        projectRoot,
        ...args,
        "--json",
        "--no-interactive",
      ]);
    const exec = (service: string, ...argv: string[]) =>
      invoke([cli, "--path", projectRoot, "exec", service, "--", ...argv]);
    const receipt = async () => {
      const mapping = await loadNativeProjectRun(scope);
      if (!mapping) {
        throw new Error("Fixture did not record a run");
      }
      const result = await command([
        runtime,
        "--candidate-root",
        nativeHome,
        "graph",
        "inspect",
        "--run-id",
        mapping.run,
        "--json",
      ]);
      if (!isRecord(result.receipt)) {
        throw new Error("Fixture did not return a receipt");
      }
      return result.receipt;
    };
    await mkdir(join(projectRoot, "src"));
    await writeFile(join(projectRoot, "src", "marker"), "shared source");
    // The complete file stays unchanged across the initial partial start,
    // append, down and restore. Its declaration order differs from sorted JSON.
    await writeFile(
      composeFile,
      JSON.stringify({
        services: { web, redis },
        volumes: { zdata: {}, adata: {} },
      })
    );
    try {
      expect(await hack("up", "web", "--detach", "--wait")).toMatchObject({
        ok: true,
        data: { services: { started: ["web"] } },
      });
      expect(await exec("web", "cat", "/app/marker")).toBe("shared source");
      await exec("web", "/bin/sh", "-c", "printf 'web data' > /data/marker");
      const partial = await receipt();
      expect(await hack("up", "--detach", "--wait")).toMatchObject({
        ok: true,
        data: { services: { started: ["redis"] } },
      });
      await exec(
        "redis",
        "/bin/sh",
        "-c",
        "printf 'redis data' > /data/marker"
      );
      await hack("down");
      const stopped = await receipt();
      expect(stopped.phase).toBe("stopped-data-retained");
      expect(stopped.plan_id).toBe(partial.plan_id);
      expect(stopped.input_plan_id).toMatch(/^[a-f0-9]{64}$/);
      await hack("up", "--detach", "--wait");
      expect(await receipt()).toMatchObject({
        run: stopped.run,
        phase: "ready-observed",
        plan_id: stopped.plan_id,
        input_plan_id: stopped.input_plan_id,
        normalized_input: stopped.normalized_input,
      });
      expect(await exec("web", "cat", "/app/marker", "/data/marker")).toBe(
        "shared sourceweb data"
      );
      expect(await exec("redis", "cat", "/data/marker")).toBe("redis data");
    } finally {
      if (await loadNativeProjectRun(scope)) {
        await hack("down");
        await hack("down", "--remove-data", "--yes");
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  8 * 60_000
);
