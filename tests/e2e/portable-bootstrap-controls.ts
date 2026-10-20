/**
 * Pure decisions and value-free receipts for the `portable-bootstrap-negatives`
 * Docker scenario. Everything here is free of I/O so the stage expectations,
 * app-identity classification, worktree-diff checks and receipt shape can be
 * exercised (and mutation-tested) without a Docker engine.
 *
 * Receipts carry only closed stage/outcome/transition names and non-negative
 * integers. They never include env values, keys, secrets, command output,
 * resource IDs, image IDs or file paths.
 */

/** Canonical stage order; a receipt must contain each stage exactly once. */
export const PORTABLE_BOOTSTRAP_STAGES = [
  "refuse-missing-key",
  "refuse-wrong-key",
  "refuse-wrong-overlay",
  "bootstrap-cold",
  "bootstrap-repeat",
  "refuse-wrong-key-running",
  "refuse-stale-image",
  "refuse-frozen-lockfile",
  "bootstrap-changed-lockfile",
  "refuse-corrupted-cache",
  "bootstrap-new-generation",
] as const;

export type PortableBootstrapStage = (typeof PORTABLE_BOOTSTRAP_STAGES)[number];

export type StageOutcome = "refused" | "bootstrapped";

/** How the single owned consumer container changed across one stage. */
export type AppTransition =
  | "absent"
  | "created"
  | "unchanged"
  | "replaced"
  | "removed";

export type AppIdentity = {
  readonly id: string;
  readonly startedAt: string;
  readonly running: boolean;
} | null;

type StageExpectation = {
  readonly outcome: StageOutcome;
  readonly app: Exclude<AppTransition, "removed">;
};

/**
 * Every refusal must leave the consumer exactly as it was: absent before the
 * first successful bootstrap, otherwise the same running container. A repeat
 * bootstrap must not recreate it; only a changed cache identity may replace it.
 */
export const PORTABLE_BOOTSTRAP_EXPECTATIONS: Readonly<
  Record<PortableBootstrapStage, StageExpectation>
> = {
  "refuse-missing-key": { outcome: "refused", app: "absent" },
  "refuse-wrong-key": { outcome: "refused", app: "absent" },
  "refuse-wrong-overlay": { outcome: "refused", app: "absent" },
  "bootstrap-cold": { outcome: "bootstrapped", app: "created" },
  "bootstrap-repeat": { outcome: "bootstrapped", app: "unchanged" },
  "refuse-wrong-key-running": { outcome: "refused", app: "unchanged" },
  "refuse-stale-image": { outcome: "refused", app: "unchanged" },
  "refuse-frozen-lockfile": { outcome: "refused", app: "unchanged" },
  "bootstrap-changed-lockfile": { outcome: "bootstrapped", app: "replaced" },
  "refuse-corrupted-cache": { outcome: "refused", app: "unchanged" },
  "bootstrap-new-generation": { outcome: "bootstrapped", app: "replaced" },
};

/** Same container ID and start time means the consumer was not touched. */
export function classifyAppTransition(opts: {
  readonly before: AppIdentity;
  readonly after: AppIdentity;
}): AppTransition {
  const { before, after } = opts;
  if (before === null) {
    return after === null ? "absent" : "created";
  }
  if (after === null) {
    return "removed";
  }
  return before.id === after.id && before.startedAt === after.startedAt
    ? "unchanged"
    : "replaced";
}

/**
 * Compare one observed stage with its fixed expectation. Returns a fixed,
 * value-free failure reason, or null when the stage behaved as required.
 */
export function checkStageExpectation(opts: {
  readonly stage: PortableBootstrapStage;
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly transition: AppTransition;
  readonly running: boolean;
}): string | null {
  const expected = PORTABLE_BOOTSTRAP_EXPECTATIONS[opts.stage];
  if (opts.timedOut) {
    return "command timed out";
  }
  const outcome: StageOutcome =
    opts.exitCode === 0 ? "bootstrapped" : "refused";
  if (outcome !== expected.outcome) {
    return `expected ${expected.outcome}, observed ${outcome}`;
  }
  if (opts.transition !== expected.app) {
    return `expected consumer ${expected.app}, observed ${opts.transition}`;
  }
  if (expected.app !== "absent" && !opts.running) {
    return "consumer must be running after the stage";
  }
  return null;
}

/**
 * Paths from `git status --porcelain=v1 --untracked-files=all` that are not in
 * `allowed`. Renames report their destination. An empty result means the
 * worktree differs from HEAD only by the allowed paths.
 */
export function unexpectedWorktreeChanges(opts: {
  readonly porcelain: string;
  readonly allowed: readonly string[];
}): readonly string[] {
  const unexpected: string[] = [];
  for (const line of opts.porcelain.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const entry = line.slice(3);
    const arrow = entry.lastIndexOf(" -> ");
    const path = arrow >= 0 ? entry.slice(arrow + 4) : entry;
    if (!opts.allowed.includes(path)) {
      unexpected.push(path);
    }
  }
  return unexpected.sort();
}

/** True when any non-empty forbidden value occurs in any text. */
export function containsForbiddenValue(opts: {
  readonly texts: readonly string[];
  readonly forbidden: readonly string[];
}): boolean {
  return opts.forbidden.some(
    (value) =>
      value.length > 0 && opts.texts.some((text) => text.includes(value))
  );
}

export type StageReceipt = {
  readonly stage: PortableBootstrapStage;
  readonly outcome: StageOutcome;
  readonly app: AppTransition;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  /** Bytes of Git-tracked fixture files after the stage. */
  readonly trackedBytes: number;
  /** Content bytes in the consumer's mounted cache; null without a consumer. */
  readonly cacheBytes: number | null;
  /** Owned dependency-cache volumes after the stage. */
  readonly cacheVolumes: number;
};

export const PORTABLE_BOOTSTRAP_RECEIPT_SCHEMA =
  "hack.e2e.portable-bootstrap-negatives.v1";

const RECEIPT_KEYS = [
  "stage",
  "outcome",
  "app",
  "durationMs",
  "stdoutBytes",
  "stderrBytes",
  "trackedBytes",
  "cacheBytes",
  "cacheVolumes",
] as const;

const OUTCOMES: readonly string[] = ["refused", "bootstrapped"];
const TRANSITIONS: readonly string[] = [
  "absent",
  "created",
  "unchanged",
  "replaced",
  "removed",
];

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function invalidReceipt(): Error {
  return new Error(
    "Invalid portable bootstrap receipt: require each canonical stage once, closed names and non-negative integer measurements"
  );
}

/**
 * Validate a complete receipt and render it as one JSON line. Unknown keys,
 * missing or reordered stages, open-ended strings and non-integer
 * measurements are refused with one fixed error, so a receipt can carry only
 * value-free data.
 */
export function renderPortableBootstrapReceipt(opts: {
  readonly stages: readonly unknown[];
  readonly imageBytes: unknown;
}): string {
  if (
    !count(opts.imageBytes) ||
    opts.stages.length !== PORTABLE_BOOTSTRAP_STAGES.length
  ) {
    throw invalidReceipt();
  }
  const stages: StageReceipt[] = [];
  for (const [index, value] of opts.stages.entries()) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw invalidReceipt();
    }
    const keys = Object.keys(value);
    if (
      keys.length !== RECEIPT_KEYS.length ||
      !RECEIPT_KEYS.every((key) => Object.hasOwn(value, key))
    ) {
      throw invalidReceipt();
    }
    const record = value as Record<(typeof RECEIPT_KEYS)[number], unknown>;
    const stage = PORTABLE_BOOTSTRAP_STAGES[index];
    if (
      stage === undefined ||
      record.stage !== stage ||
      typeof record.outcome !== "string" ||
      !OUTCOMES.includes(record.outcome) ||
      typeof record.app !== "string" ||
      !TRANSITIONS.includes(record.app) ||
      !count(record.durationMs) ||
      !count(record.stdoutBytes) ||
      !count(record.stderrBytes) ||
      !count(record.trackedBytes) ||
      !(record.cacheBytes === null || count(record.cacheBytes)) ||
      !count(record.cacheVolumes)
    ) {
      throw invalidReceipt();
    }
    stages.push({
      stage,
      outcome: record.outcome as StageOutcome,
      app: record.app as AppTransition,
      durationMs: record.durationMs,
      stdoutBytes: record.stdoutBytes,
      stderrBytes: record.stderrBytes,
      trackedBytes: record.trackedBytes,
      cacheBytes: record.cacheBytes,
      cacheVolumes: record.cacheVolumes,
    });
  }
  return JSON.stringify({
    schema: PORTABLE_BOOTSTRAP_RECEIPT_SCHEMA,
    imageBytes: opts.imageBytes,
    stages,
  });
}

/** Owner label on every fixture container, volume and probe. */
export const PORTABLE_BOOTSTRAP_OWNER = "hack.e2e.portable-bootstrap-owner";

/**
 * Frozen install: refuse a lockfile whose manifest digest no longer matches
 * `package.json`. The workspace is mounted read-only, so the installer cannot
 * repair the lockfile by rewriting it.
 */
export const PORTABLE_BOOTSTRAP_INSTALL_SCRIPT = [
  "set -eu",
  "manifest=$(sha256sum /workspace/package.json | cut -d ' ' -f1)",
  'grep -qx "manifest=$manifest" /workspace/bun.lock || { echo "frozen lockfile mismatch" >&2; exit 23; }',
  "echo initialized >> /deps/initializations",
  "sha256sum /workspace/bun.lock | cut -d ' ' -f1 > /deps/artifact",
  "",
].join("\n");

export const PORTABLE_BOOTSTRAP_VERIFY_SCRIPT = [
  "set -eu",
  'test "$(cat /deps/artifact)" = "$(sha256sum /workspace/bun.lock | cut -d \' \' -f1)"',
  'test "$(wc -l < /deps/initializations)" -eq 1',
  "",
].join("\n");

export function sha256Hex(data: string): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

/** Lockfile bound to one manifest digest; a new revision changes the cache key. */
export function renderBootstrapLock(opts: {
  readonly manifest: string;
  readonly revision: number;
}): string {
  return `manifest=${sha256Hex(opts.manifest)}\nrevision=${opts.revision}\n`;
}

/** Project env file whose only value is an app-scoped sealed token. */
export function renderBootstrapEnvFile(opts: {
  readonly environment: string;
  readonly sealed: string;
}): string {
  return [
    "version: 1",
    `environment: ${opts.environment}`,
    "secretsprovider: project_key",
    "values:",
    "  app:",
    "    BOOTSTRAP_TOKEN:",
    `      secure: ${opts.sealed}`,
    "",
  ].join("\n");
}

/**
 * A locked-v1 producer (`deps`) and a read-only consumer (`app`) on one pinned
 * image, with no network, ports or pulls. The consumer exits 41 unless the
 * injected token matches `tokenDigest`, and copies the cache artifact only
 * after that check, so a loaded artifact proves env injection succeeded
 * without the scenario ever reading the value.
 */
export function renderBootstrapCompose(opts: {
  readonly name: string;
  readonly ref: string;
  readonly platform: string;
  readonly generation: string;
  readonly tokenDigest: string;
}): string {
  const base = {
    image: opts.ref,
    platform: opts.platform,
    pull_policy: "never",
    network_mode: "none",
  };
  const app = [
    "set -eu",
    `test "$(printf %s "\${BOOTSTRAP_TOKEN:-}" | sha256sum | cut -d ' ' -f1)" = ${opts.tokenDigest} || exit 41`,
    "cp /deps/artifact /tmp/loaded",
    "exec sleep 3600",
  ].join("\n");
  const labels = { [PORTABLE_BOOTSTRAP_OWNER]: opts.name };
  return `${JSON.stringify(
    {
      name: opts.name,
      services: {
        deps: {
          ...base,
          entrypoint: [],
          command: ["sh", "/workspace/deps/install.sh"],
          labels: {
            ...labels,
            "hack.dependencies.cache-volume": "deps",
            "hack.dependencies.lockfiles": "bun.lock",
            "hack.dependencies.runtime-files":
              "package.json,deps/install.sh,deps/verify.sh",
            "hack.dependencies.cache-protocol": "locked-v1",
            "hack.dependencies.cache-generation": opts.generation,
            "hack.dependencies.cache-verify": JSON.stringify([
              "sh",
              "/workspace/deps/verify.sh",
            ]),
          },
          volumes: ["deps:/deps", "..:/workspace:ro"],
        },
        app: {
          ...base,
          labels,
          // Compose must pass shell expansions to the container unchanged.
          command: ["sh", "-c", app.replaceAll("$", () => "$$")],
          depends_on: {
            deps: { condition: "service_completed_successfully" },
          },
          volumes: ["deps:/deps:ro"],
        },
      },
      volumes: { deps: { labels } },
    },
    null,
    2
  )}\n`;
}
