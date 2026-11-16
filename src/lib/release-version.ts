import { LIFECYCLE_SUPERVISOR_HANDSHAKE_ARGUMENT } from "./lifecycle-supervisor-handshake.ts";
import { execOrThrow } from "./shell.ts";

/** Execute only a checksum-verified staged CLI and require its documented output. */
export async function verifyStagedReleaseVersion(
  binary: string,
  version: string
): Promise<void> {
  const result = await execOrThrow([binary, "--version"], {
    stdin: "ignore",
    timeoutMs: 10_000,
  });
  if (result.stdout.trim() !== `hack v${version}`) {
    throw new Error(
      "Downloaded CLI version does not match the selected release; installation unchanged."
    );
  }
}

const HANDSHAKE_PATTERN =
  /^hack-lifecycle-supervisor \S+ protocol=\d+ incremental=\d+$/;

async function outputOf(command: readonly string[]): Promise<string | null> {
  const child = Bun.spawn([...command], {
    env: {},
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: 10_000,
  });
  const [code, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  return code === 0 ? stdout.trim() : null;
}

/**
 * Before publication, require the staged companion to answer exactly the
 * handshake its staged CLI expects, so an upgrade cannot replace a working
 * pair with a CLI whose supervisor preflight (and therefore native stop)
 * fails. Staged CLIs that do not declare a handshake are legacy releases.
 */
export async function verifyStagedLifecycleSupervisor(opts: {
  readonly cli: string;
  readonly supervisor: string | null;
}): Promise<void> {
  const expected = await outputOf([
    opts.cli,
    LIFECYCLE_SUPERVISOR_HANDSHAKE_ARGUMENT,
  ]);
  if (expected === null || !HANDSHAKE_PATTERN.test(expected)) {
    return;
  }
  const actual = opts.supervisor
    ? await outputOf([opts.supervisor, "--version"])
    : null;
  if (actual !== expected) {
    throw new Error(
      "Release lifecycle supervisor companion is missing or does not match its CLI; installation unchanged."
    );
  }
}
