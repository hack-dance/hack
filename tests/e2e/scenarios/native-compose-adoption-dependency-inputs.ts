import { isRecord } from "../../../src/lib/guards.ts";

export const adoptionDependencyHealthcheck = {
  test: ["CMD", "pg_isready", "-U", "postgres", "-d", "fixture"],
  interval: "1s",
  timeout: "1s",
  retries: 30,
} as const;

function refused(): never {
  throw new Error(
    "Adoption dependency fixture ordering check failed; values omitted."
  );
}

/** Independent oracle for the actual forwarded start, not an extra simulated engine effect. */
export function assertAdoptionDependencyStart(opts: {
  readonly db: string;
  readonly worker: string;
  readonly prior: readonly string[];
  readonly requested: string;
  readonly condition: "service_started" | "service_healthy";
  readonly observed?: unknown;
}): void {
  if (opts.prior.length === 0 && opts.requested === opts.db) {
    return;
  }
  const row = opts.observed;
  if (
    opts.prior.length !== 1 ||
    opts.prior[0] !== opts.db ||
    opts.requested !== opts.worker ||
    !isRecord(row) ||
    Object.keys(row).sort().join() !== "health,id,paused,running,status" ||
    row.id !== opts.db ||
    row.running !== true ||
    row.paused !== false ||
    row.status !== "running" ||
    typeof row.health !== "string" ||
    !["", "starting", "healthy", "unhealthy"].includes(row.health) ||
    (opts.condition === "service_healthy" && row.health !== "healthy")
  ) {
    refused();
  }
}

/** Observe only the explicit synthetic container probe contract, never image settings or environment. */
export function assertAdoptionDependencyHealthcheck(row: unknown): void {
  if (
    !isRecord(row) ||
    Object.keys(row).sort().join() !== "interval,retries,test,timeout" ||
    JSON.stringify(row.test) !==
      JSON.stringify(adoptionDependencyHealthcheck.test) ||
    row.interval !== 1_000_000_000 ||
    row.timeout !== 1_000_000_000 ||
    row.retries !== 30
  ) {
    refused();
  }
}
