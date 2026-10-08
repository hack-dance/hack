import { join } from "node:path";
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

/** Fixed stage/code flags preserve the failure boundary without exposing CLI output or authored values. */
export function assertAdoptionDependencyControl(opts: {
  readonly stage: "prepared-stop" | "pending-start" | "ordered-start";
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly control: "missing" | "invalid" | "valid";
}): void {
  const validExit = Number.isSafeInteger(opts.exitCode) && opts.exitCode >= 0;
  const exitCode = validExit ? opts.exitCode : -1;
  const stage = ["prepared-stop", "pending-start", "ordered-start"].includes(
    opts.stage
  )
    ? opts.stage
    : "invalid-stage";
  const control = ["missing", "invalid", "valid"].includes(opts.control)
    ? opts.control
    : "invalid";
  const expectedExit =
    stage === "ordered-start" ? exitCode === 0 : exitCode !== 0;
  if (
    stage === "invalid-stage" ||
    !validExit ||
    typeof opts.timedOut !== "boolean" ||
    opts.timedOut ||
    !expectedExit ||
    control !== "valid"
  ) {
    throw new Error(
      `Adoption dependency fixture failed: stage=${stage} exit=${exitCode} timedOut=${opts.timedOut === true} control=${control}; values omitted.`
    );
  }
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

// Digests identify fixed PUBLIC Go templates in the legacy binding/runtime owner;
// they contain no source values, resource facts or private revision fingerprints.
const DEPENDENCY_READ_FORMATS = {
  container: {
    list: "b2e981e67b44cf6e783ce33d9bf30e6acf8ece4f4577e0e271b2375d041a49be",
    inspect: [
      "51d0339130db3ac49d475ed2c5060e8cf1ab97111f3f158c19062b787ec3e65e",
      "a0c775c27577062be0deaf03cc10ccec9deec5512c7f75fa0225ac0fbef58764",
      "2678a2db0e9f357cd7f58dd42d5dc613371e3d69b29a20bab7d37959d73fb551",
      "999c6f5f7f6765c00dbb66f7fc6aa2decef1ec316f7fb6ddcadaa64a1a36eaa8",
      "177b76bf4a78ee1c08b0339090b509dcf018d70110b78b4a0a283fd59bf8ed73",
    ],
  },
  volume: {
    list: "01ee48d74bb07015309dbffd72dfa3772d575a2a0d94f04a9705b6a97ff77d17",
    inspect: [
      "93629bf0b155d7cb6fa1a3dee9db7f2d1b9fe82f8dcc8e3a0adc6195015d4a2b",
    ],
  },
  network: {
    list: "a3f4075791229cc53f295c6c4b9c78b68359a4b57e287264860fd6d61bc691d2",
    inspect: [
      "ef5e2f4a0414ce7ee2e9616097085f8ea2e75552ce1181f0fab00d924e081c12",
    ],
  },
} as const;

type DependencyReadScope = {
  readonly args: readonly string[];
  readonly projectRoot: string;
  readonly project: string;
  readonly containerIds: readonly string[];
  readonly networkId: string;
  readonly volumeName: string;
  readonly generationId?: unknown;
};

function dependencyComposeReadAllowed(opts: DependencyReadScope): boolean {
  const prefix = [
    "compose",
    "--project-name",
    opts.project,
    "--project-directory",
    join(opts.projectRoot, ".hack"),
    "--env-file",
    "/dev/null",
    "--profile",
    "*",
    "--file",
  ];
  const suffix = ["config", "--no-env-resolution", "--hash", "*"];
  const files = [join(opts.projectRoot, ".hack/docker-compose.yml")];
  if (
    typeof opts.generationId === "string" &&
    /^[a-f0-9]{32}$/.test(opts.generationId)
  ) {
    files.push(
      join(
        opts.projectRoot,
        ".hack/.internal/legacy-compose-adoption-v1/generations",
        opts.generationId,
        "legacy-compose.yml"
      )
    );
  }
  return files.some(
    (file) =>
      JSON.stringify(opts.args) === JSON.stringify([...prefix, file, ...suffix])
  );
}

/** Closed read-only passthrough for dependency fixture shims; every mutation is handled separately. */
export function adoptionDependencyReadAllowed(
  opts: DependencyReadScope
): boolean {
  const { args } = opts;
  const same = (expected: readonly string[]) =>
    JSON.stringify(args) === JSON.stringify(expected);
  if (args[0] === "info") {
    return (
      same(["info", "--format", '{"id":{{json .ID}},"os":{{json .OSType}}}']) ||
      same(["info", "--format", "{{json .ID}}"])
    );
  }
  if (args[0] === "compose") {
    return dependencyComposeReadAllowed(opts);
  }
  const kind = args[0];
  if (kind !== "container" && kind !== "volume" && kind !== "network") {
    return false;
  }
  const formats = DEPENDENCY_READ_FORMATS[kind];
  const digest = (format: string) =>
    new Bun.CryptoHasher("sha256").update(format).digest("hex");
  if (args[1] === "ls") {
    const prefix = [
      kind,
      "ls",
      ...(kind === "container" ? ["--all"] : []),
      ...(kind === "volume" ? [] : ["--no-trunc"]),
      "--format",
    ];
    return (
      args.length === prefix.length + 1 &&
      JSON.stringify(args.slice(0, -1)) === JSON.stringify(prefix) &&
      digest(args.at(-1) ?? "") === formats.list
    );
  }
  const ids =
    kind === "container"
      ? opts.containerIds
      : kind === "volume"
        ? [opts.volumeName]
        : [opts.networkId];
  return (
    args.length === 5 &&
    args[1] === "inspect" &&
    args[2] === "--format" &&
    ids.includes(args[4] ?? "") &&
    formats.inspect.some((format) => format === digest(args[3] ?? ""))
  );
}
