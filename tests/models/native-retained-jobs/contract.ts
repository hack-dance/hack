/**
 * Offline draft only. This module is not a production receipt codec, writer or
 * mutation capability. Version 7 has no registered production consumer.
 */
const ID = /^[a-f0-9]{64}$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/;
export const NEVER_STARTED = "0001-01-01T00:00:00Z";

export type OriginalDraft = {
  readonly name: string;
  readonly kind: "service" | "job";
  readonly id: string;
  readonly configHash: string;
};
export type Version7SelectionDraft = {
  readonly adoption_receipt_version: 7;
  readonly adoption_generation_version: 7;
  readonly binding_version: 1;
  readonly sourceFamily: "static-pair";
  readonly networkFamily: "default-bridge";
  readonly managed: false;
  readonly typedLocal: false;
  readonly profiles: false;
  readonly routing: false;
  readonly hostHooks: false;
  readonly originals: readonly OriginalDraft[];
};
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function closed(
  value: unknown,
  names: string
): value is Record<string, unknown> {
  return (
    record(value) &&
    Reflect.ownKeys(value).length === names.split(",").length &&
    Object.getOwnPropertyNames(value).sort().join(",") === names &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((item) =>
      Object.hasOwn(item, "value")
    )
  );
}
function dense(value: unknown): value is unknown[] {
  return (
    Array.isArray(value) &&
    Object.keys(value).length === value.length &&
    Object.keys(value).every((key, index) => key === String(index)) &&
    Reflect.ownKeys(value).length === value.length + 1 &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((item) =>
      Object.hasOwn(item, "value")
    )
  );
}
function hash(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}
function original(value: unknown): value is OriginalDraft {
  return (
    closed(value, "configHash,id,kind,name") &&
    typeof value.name === "string" &&
    NAME.test(value.name) &&
    (value.kind === "service" || value.kind === "job") &&
    hash(value.id) &&
    hash(value.configHash)
  );
}

/** A version/family/membership projection, deliberately not the complete saved wire. */
export function decodeVersion7SelectionDraft(
  value: unknown
): Version7SelectionDraft | undefined {
  if (
    !closed(
      value,
      "adoption_generation_version,adoption_receipt_version,binding_version,hostHooks,managed,networkFamily,originals,profiles,routing,sourceFamily,typedLocal"
    ) ||
    value.adoption_receipt_version !== 7 ||
    value.adoption_generation_version !== 7 ||
    value.binding_version !== 1 ||
    value.sourceFamily !== "static-pair" ||
    value.networkFamily !== "default-bridge" ||
    value.managed !== false ||
    value.typedLocal !== false ||
    value.profiles !== false ||
    value.routing !== false ||
    value.hostHooks !== false ||
    !dense(value.originals) ||
    !value.originals.length ||
    !value.originals.every(original) ||
    !value.originals.some((item) => item.kind === "job") ||
    new Set(value.originals.map((item) => item.name)).size !==
      value.originals.length ||
    new Set(value.originals.map((item) => item.id)).size !==
      value.originals.length
  ) {
    return undefined;
  }
  // Copy closed fields, never preserve caller prototypes/accessors as authority.
  const originals = value.originals.map((item) =>
    Object.freeze({
      name: item.name,
      kind: item.kind,
      id: item.id,
      configHash: item.configHash,
    })
  );
  return Object.freeze({
    adoption_receipt_version: 7,
    adoption_generation_version: 7,
    binding_version: 1,
    sourceFamily: "static-pair",
    networkFamily: "default-bridge",
    managed: false,
    typedLocal: false,
    profiles: false,
    routing: false,
    hostHooks: false,
    originals: Object.freeze(originals),
  });
}

export type DraftFence = {
  readonly generation: boolean;
  readonly source: boolean;
  readonly engine: boolean;
  readonly originals: boolean;
  readonly configuration: boolean;
};
/** Rechecked after awaited observations and immediately before every proposed effect/commit. */
export function canAdmitDraftEffect(opts: {
  readonly fence: DraftFence;
  readonly deadline: number;
  readonly now: number;
  readonly cancelled: boolean;
}): boolean {
  return (
    Object.values(opts.fence).every((item) => item === true) &&
    opts.fence.generation === true &&
    opts.fence.source === true &&
    opts.fence.engine === true &&
    opts.fence.originals === true &&
    opts.fence.configuration === true &&
    opts.cancelled === false &&
    Number.isFinite(opts.now) &&
    Number.isFinite(opts.deadline) &&
    opts.now < opts.deadline
  );
}

export type JobAttemptDraft = {
  readonly id: string;
  readonly priorStartedAt: string;
  /** True only after this invocation's admitted exact-ID start child settles successfully. */
  readonly started: boolean;
};
export type ObservationDraft = {
  readonly id: string;
  readonly running: boolean;
  readonly paused: boolean;
  readonly status: "created" | "running" | "exited" | "dead";
  readonly exitCode: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly restartPolicy: "no" | "always" | "unless-stopped" | "on-failure";
  readonly maximumRetryCount: number;
};
/** Compare exact UTC instants without discarding submillisecond precision. */
function timestampInstant(value: string): bigint | undefined {
  const match = TIME.exec(value);
  const base = match?.[1];
  if (!base) {
    return undefined;
  }
  const milliseconds = Date.parse(`${base}Z`);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 19) !== base
  ) {
    return undefined;
  }
  return (
    BigInt(milliseconds) * 1_000_000n +
    BigInt((match?.[2] ?? "").padEnd(9, "0"))
  );
}
const NEVER_STARTED_INSTANT = timestampInstant(NEVER_STARTED);
function validObservation(value: unknown): value is ObservationDraft {
  if (
    !closed(
      value,
      "exitCode,finishedAt,id,maximumRetryCount,paused,restartPolicy,running,startedAt,status"
    )
  ) {
    return false;
  }
  return (
    hash(value.id) &&
    typeof value.running === "boolean" &&
    typeof value.paused === "boolean" &&
    typeof value.status === "string" &&
    ["created", "running", "exited", "dead"].includes(value.status) &&
    typeof value.exitCode === "number" &&
    Number.isInteger(value.exitCode) &&
    value.exitCode >= 0 &&
    value.exitCode <= 255 &&
    typeof value.startedAt === "string" &&
    timestampInstant(value.startedAt) !== undefined &&
    typeof value.finishedAt === "string" &&
    timestampInstant(value.finishedAt) !== undefined &&
    typeof value.restartPolicy === "string" &&
    ["no", "always", "unless-stopped", "on-failure"].includes(
      value.restartPolicy
    ) &&
    typeof value.maximumRetryCount === "number" &&
    Number.isInteger(value.maximumRetryCount) &&
    value.maximumRetryCount >= 0 &&
    value.maximumRetryCount <= 4_294_967_295
  );
}

/** An old exit zero is never completion of a newly admitted attempt. */
export function freshJobResultDraft(opts: {
  readonly selection: Version7SelectionDraft;
  readonly attempt: JobAttemptDraft;
  readonly observations: unknown;
}): "ready" | "waiting" | "failed" | "refused" {
  const { originals } = opts.selection;
  if (
    !dense(opts.observations) ||
    opts.observations.length !== originals.length ||
    !opts.observations.every(validObservation)
  ) {
    return "refused";
  }
  const observed: ObservationDraft[] = opts.observations;
  const byId = new Map(observed.map((item) => [item.id, item]));
  if (
    byId.size !== originals.length ||
    originals.some((item) => !byId.has(item.id))
  ) {
    return "refused";
  }
  const job = originals.find(
    (item) => item.kind === "job" && item.id === opts.attempt.id
  );
  const row = byId.get(opts.attempt.id);
  const priorStartedAt = timestampInstant(opts.attempt.priorStartedAt);
  if (
    !(job && row) ||
    priorStartedAt === undefined ||
    row.paused ||
    row.status === "dead" ||
    row.restartPolicy !== "no" ||
    row.maximumRetryCount !== 0
  ) {
    return "refused";
  }
  const startedAt = timestampInstant(row.startedAt);
  const finishedAt = timestampInstant(row.finishedAt);
  if (row.status === "exited" && !row.running && row.exitCode !== 0) {
    return "failed";
  }
  const fresh =
    opts.attempt.started === true &&
    startedAt !== NEVER_STARTED_INSTANT &&
    startedAt !== priorStartedAt;
  if (!fresh) {
    return "waiting";
  }
  if (
    row.status === "exited" &&
    !row.running &&
    finishedAt !== NEVER_STARTED_INSTANT &&
    row.exitCode === 0
  ) {
    return "ready";
  }
  return row.status === "running" && row.running ? "waiting" : "refused";
}
