import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * A real foreground hackd in a private home: Docker points at a dead socket,
 * its event watcher is off, and login-service management and autostart are
 * disabled. The test owns the spawned process and stops it in afterEach.
 * Guards the daemon's idle timeout: Bun's 10 s default would close a
 * `/v1/projects?wait=` long-poll before it answers.
 */
const REPO_ROOT = resolve(import.meta.dir, "..");
const ENTRY = join(REPO_ROOT, "index.ts");

let root: string | null = null;
let daemon: ReturnType<typeof Bun.spawn> | null = null;

afterEach(async () => {
  if (daemon) {
    daemon.kill("SIGTERM");
    const exited = await Promise.race([
      daemon.exited.then(() => true),
      Bun.sleep(5000).then(() => false),
    ]);
    if (!exited) {
      daemon.kill("SIGKILL");
      await daemon.exited;
    }
    daemon = null;
  }
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = null;
  }
});

async function startDaemon(): Promise<{
  readonly socket: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
}> {
  // Under /tmp: the socket path must fit the platform's sun_path limit.
  const cwd = await mkdtemp(join(await realpath("/tmp"), "hack-dw-"));
  root = cwd;
  const home = join(cwd, "home");
  await mkdir(home, { recursive: true, mode: 0o755 });
  const env = {
    HOME: home,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: tmpdir(),
    HACK_NO_INTERACTIVE: "1",
    HACK_DAEMON_AUTOSTART_DISABLE: "1",
    HACK_DAEMON_DISABLE_DOCKER_EVENTS: "1",
    HACK_SYSTEMD_DISABLE: "1",
    HACK_LAUNCHD_DISABLE: "1",
    HACK_LOGGER: "console",
    DOCKER_HOST: `unix://${join(cwd, "no-docker.sock")}`,
    DOCKER_CONFIG: join(cwd, "docker-config"),
  };
  daemon = Bun.spawn(
    [process.execPath, ENTRY, "daemon", "start", "--foreground"],
    { cwd, env, stdin: "ignore", stdout: "ignore", stderr: "ignore" }
  );
  const socket = join(home, ".hack", "daemon", "hackd.sock");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const ok = await fetch("http://hackd/v1/status", { unix: socket })
      .then((response) => response.ok)
      .catch(() => false);
    if (ok) {
      return { socket, cwd, env };
    }
    await Bun.sleep(100);
  }
  throw new Error("hackd did not answer on its socket");
}

test("a projects long-poll outlives Bun's default 10 s idle timeout", async () => {
  const { socket, cwd, env } = await startDaemon();
  const first = (await fetch("http://hackd/v1/projects", {
    unix: socket,
  }).then((response) => response.json())) as { state_token?: unknown };
  expect(first.state_token).toMatch(/^[0-9a-f]{32}$/);

  const started = Date.now();
  const response = await fetch(
    `http://hackd/v1/projects?wait=${first.state_token}&wait_timeout_ms=12000`,
    { unix: socket }
  );
  const elapsed = Date.now() - started;
  expect(response.status).toBe(200);
  const body = (await response.json()) as { state_token?: unknown };
  // Nothing changed, so the wait ran to its timeout and kept the token.
  expect(body.state_token).toBe(first.state_token);
  expect(elapsed).toBeGreaterThanOrEqual(11_500);

  const invalid = await fetch("http://hackd/v1/projects?wait=bad", {
    unix: socket,
  });
  expect(invalid.status).toBe(400);

  // The CLI listing served by this daemon keeps its published shape.
  const cli = Bun.spawn([process.execPath, ENTRY, "projects", "--json"], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const killer = setTimeout(() => cli.kill("SIGKILL"), 20_000);
  const [stdout, code] = await Promise.all([
    new Response(cli.stdout).text(),
    cli.exited,
  ]);
  clearTimeout(killer);
  expect(code).toBe(0);
  const listing = JSON.parse(stdout) as Record<string, unknown>;
  expect(listing).toHaveProperty("projects");
  expect(listing).not.toHaveProperty("state_token");
}, 60_000);
