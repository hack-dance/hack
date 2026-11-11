/**
 * Test launcher for background commands: runs startBackgroundCommand in its
 * own process, as `hack exec --detach` would after resolving a project, with
 * a fixture child argv instead of `docker compose`. Config is one JSON
 * argument. With `linger`, the launcher stays alive after printing its result
 * so a test can kill its whole session.
 */
import { startBackgroundCommand } from "../../src/lib/background-command/launch.ts";

type LauncherConfig = {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly requestKey?: string;
  readonly timeoutMs?: number;
  readonly stallAfterMs?: number;
  readonly capture?: "full" | "metadata";
  readonly redactValues?: readonly string[];
  readonly linger?: boolean;
};

// `@<path>` reads the config from a file (large redaction values would not
// fit in one argv string).
const rawConfig = process.argv[2] ?? "{}";
const config = JSON.parse(
  rawConfig.startsWith("@")
    ? await Bun.file(rawConfig.slice(1)).text()
    : rawConfig
) as LauncherConfig;
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === "string") {
    env[key] = value;
  }
}
try {
  process.exitCode = await startBackgroundCommand({
    request: {
      requestKey: config.requestKey ?? null,
      json: true,
      ...(config.timeoutMs === undefined
        ? {}
        : { timeoutMs: config.timeoutMs }),
      ...(config.stallAfterMs === undefined
        ? {}
        : { stallAfterMs: config.stallAfterMs }),
      ...(config.capture === undefined ? {} : { capture: config.capture }),
    },
    operation: "exec",
    backend: "compose",
    projectId: "fixture",
    projectRoot: config.cwd,
    projectDir: null,
    instanceId: "@base",
    service: "api",
    argv: [...config.argv],
    workdir: null,
    child: { argv: config.argv, cwd: config.cwd, env },
    redactValues: config.redactValues ?? [],
    overlay: null,
  });
} catch (error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "E_UNEXPECTED";
  process.stdout.write(
    `${JSON.stringify({ ok: false, error: { code, message: String(error) } })}\n`
  );
  process.exitCode = 1;
}
if (config.linger) {
  await Bun.sleep(60_000);
}
