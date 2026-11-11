import { exec } from "../shell.ts";

const DOCKER_TIMEOUT_MS = 30_000;
const NO_SUCH_CONTAINER = /no such (object|container)/i;

/**
 * Remove a background `run`'s one-off container after its Compose client was
 * stopped (cancel or timeout); stopping the client alone leaves the
 * container, and the process in it, running.
 *
 * Ownership: the container is named by the launcher (`hack-bg-<random>`) and
 * is removed only if Docker reports it as a Compose one-off container of the
 * expected service. Returns `stopped` when it is confirmed gone (removed, or
 * already removed by `--rm`), `not_confirmed` otherwise (Docker unreachable,
 * labels do not match, removal failed).
 */
export async function removeOneOffContainer(opts: {
  readonly name: string;
  readonly service: string;
  readonly env: Readonly<Record<string, string>>;
}): Promise<"stopped" | "not_confirmed"> {
  const inspect = await docker(opts, [
    "inspect",
    "--type",
    "container",
    "--format",
    '{{index .Config.Labels "com.docker.compose.oneoff"}} {{index .Config.Labels "com.docker.compose.service"}}',
    opts.name,
  ]);
  if (inspect === null) {
    return "not_confirmed";
  }
  if (inspect.exitCode !== 0) {
    return NO_SUCH_CONTAINER.test(inspect.stderr) ? "stopped" : "not_confirmed";
  }
  if (inspect.stdout.trim() !== `True ${opts.service}`) {
    return "not_confirmed";
  }
  const removed = await docker(opts, ["rm", "--force", opts.name]);
  if (!removed) {
    return "not_confirmed";
  }
  const after = await docker(opts, [
    "inspect",
    "--type",
    "container",
    "--format",
    "{{.Id}}",
    opts.name,
  ]);
  return after !== null &&
    after.exitCode !== 0 &&
    NO_SUCH_CONTAINER.test(after.stderr)
    ? "stopped"
    : "not_confirmed";
}

async function docker(
  opts: { readonly env: Readonly<Record<string, string>> },
  args: readonly string[]
): Promise<{ exitCode: number; stdout: string; stderr: string } | null> {
  try {
    return await exec(["docker", ...args], {
      stdin: "ignore",
      timeoutMs: DOCKER_TIMEOUT_MS,
      env: { ...opts.env },
    });
  } catch {
    return null;
  }
}
