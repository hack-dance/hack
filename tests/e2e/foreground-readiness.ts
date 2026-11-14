/** Distinct service logs are required; a replay from one service is insufficient. */
export function bothForegroundServicesLogged(output: string): boolean {
  const plain = Bun.stripANSI(output);
  return (
    /^\s*app(?:-\d+)?\s*\|\s*foreground-ready:app\s*$/m.test(plain) &&
    /^\s*worker(?:-\d+)?\s*\|\s*foreground-ready:worker\s*$/m.test(plain)
  );
}

type Listing = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

/** Both named services must be running in a successful, fresh Docker listing. */
export function bothForegroundContainersRunning(listing: Listing): boolean {
  const rows = listing.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/));
  const services = new Set(rows.map((row) => row[1]));
  return (
    listing.exitCode === 0 &&
    rows.length === 2 &&
    rows.every((row) => row.length === 2) &&
    services.has("app") &&
    services.has("worker")
  );
}

/** Bound the observation race between Compose's logs and Docker's running list. */
export async function waitForForegroundContainers(opts: {
  readonly read: (timeoutMs: number) => Promise<Listing>;
  readonly alive: () => boolean;
  readonly timeoutMs?: number;
  readonly runtime?: {
    readonly now: () => number;
    readonly sleep: (ms: number) => Promise<void>;
  };
}): Promise<Listing> {
  const runtime = opts.runtime ?? {
    now: () => Date.now(),
    sleep: (ms: number) => Bun.sleep(ms),
  };
  const deadline = runtime.now() + (opts.timeoutMs ?? 15_000);
  let last: Listing = { exitCode: -1, stdout: "not read", stderr: "" };
  while (runtime.now() < deadline && opts.alive()) {
    last = await opts.read(
      Math.max(1, Math.min(15_000, deadline - runtime.now()))
    );
    if (bothForegroundContainersRunning(last)) {
      return last;
    }
    await runtime.sleep(Math.min(100, Math.max(0, deadline - runtime.now())));
  }
  throw new Error(
    `two project containers must be running before Ctrl-C; last listing (exit ${last.exitCode}): ${last.stdout} ${last.stderr}`
  );
}
