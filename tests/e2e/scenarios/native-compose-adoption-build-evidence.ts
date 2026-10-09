import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../../src/lib/guards.ts";
import {
  assertRetainedBuildFixtureCopy,
  type RetainedBuildFixtureMode,
} from "./native-compose-adoption-build-inputs.ts";

export const RETAINED_BUILD_BOOTSTRAP_ENV = Object.freeze({
  DOCKER_BUILDKIT: "1",
  BUILDX_BUILDER: "default",
});
export const RETAINED_BUILD_BUILDER_FORMAT =
  '{{if eq .DriverEndpoint "docker"}}{"name":{{json .Builder.Name}},"driver":{{json .DriverEndpoint}},"nodes":[{{range $i,$n := .Builder.Nodes}}{{if $i}},{{end}}{"name":{{json $n.Name}},"endpoint":{{json $n.Endpoint}}}{{end}}]}{{end}}';
type Stage =
  | "builder-begin"
  | "builder-qualified"
  | "build-begin"
  | "build-settled"
  | "image-admission-begin"
  | "image-admitted"
  | "graph-admitted"
  | "original-start-begin"
  | "original-start-settled"
  | "original-ids-captured"
  | "readiness-begin"
  | "readiness-qualified"
  | "sql-begin"
  | "sql-qualified"
  | "full-check-begin"
  | "full-check-qualified"
  | "source-recheck-begin"
  | "source-rechecked"
  | "runtime-image-begin"
  | "runtime-image-rechecked"
  | "copy-begin"
  | "copy-captured"
  | "copy-qualified";
export type RetainedBuildFixtureEvidence = (
  mode: RetainedBuildFixtureMode,
  stage: Stage,
  bytes?: Uint8Array
) => Promise<void>;

function refuse(): never {
  throw new Error("Retained build fixture evidence refused; values omitted.");
}

/** Fixed stages and complete synthetic COPY bytes only; no subprocess argv, arbitrary errors or host environment. */
export function createRetainedBuildFixtureEvidence(opts: {
  readonly tempRoot: string;
}): RetainedBuildFixtureEvidence {
  const root = join(opts.tempRoot, "retained-build-stages");
  let count = 0;
  const started = performance.now();
  return async (mode, stage, bytes) => {
    if (
      ++count > 512 ||
      (bytes !== undefined &&
        (stage !== "copy-captured" || bytes.byteLength > 16_384))
    ) {
      refuse();
    }
    await mkdir(root, { mode: 0o700, recursive: true });
    await writeFile(
      join(root, `${String(count).padStart(4, "0")}.json`),
      JSON.stringify({
        evidence_version: 1,
        mode,
        stage,
        elapsedMs: Math.round(performance.now() - started),
        ...(bytes === undefined
          ? {}
          : {
              byteLength: bytes.byteLength,
              copyBase64: Buffer.from(bytes).toString("base64"),
            }),
      }),
      { mode: 0o600, flag: "wx" }
    );
  };
}

/** Select only the engine's default Docker driver; no builder creation, bootstrap, remote driver or fallback. */
export async function qualifyRetainedBuildFixtureBuilder(opts: {
  readonly mode: RetainedBuildFixtureMode;
  readonly read: (args: readonly string[]) => Promise<string>;
  readonly record: RetainedBuildFixtureEvidence;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<void> {
  await opts.record(opts.mode, "builder-begin");
  if (
    opts.env.DOCKER_BUILDKIT !== "1" ||
    opts.env.BUILDX_BUILDER !== "default" ||
    opts.env.DOCKER_CONTEXT !== undefined ||
    !opts.env.DOCKER_HOST?.startsWith("unix:///")
  ) {
    refuse();
  }
  const version = await opts.read(["buildx", "version"]);
  if (
    !/^github\.com\/docker\/buildx v\d+\.\d+\.\d+(?:[-+][\w.-]+)? [a-f0-9]+\s*$/.test(
      version
    )
  ) {
    refuse();
  }
  const text = await opts.read([
    "buildx",
    "ls",
    "--timeout",
    "10s",
    "--format",
    RETAINED_BUILD_BUILDER_FORMAT,
  ]);
  const rows = text.split("\n").filter((line) => line.trim());
  if (rows.length !== 1) {
    refuse();
  }
  let value: unknown;
  try {
    value = JSON.parse(rows[0] ?? "");
  } catch {
    refuse();
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join() !== "driver,name,nodes" ||
    value.name !== "default" ||
    value.driver !== "docker" ||
    !Array.isArray(value.nodes) ||
    value.nodes.length !== 1 ||
    !isRecord(value.nodes[0]) ||
    Object.keys(value.nodes[0]).sort().join() !== "endpoint,name" ||
    value.nodes[0].name !== "default" ||
    !(
      value.nodes[0].endpoint === "default" ||
      value.nodes[0].endpoint === opts.env.DOCKER_HOST
    )
  ) {
    refuse();
  }
  await opts.record(opts.mode, "builder-qualified");
}

/** Persist the untrimmed, fatal-decoded reply before the unchanged complete COPY oracle can refuse. */
export async function qualifyRetainedBuildFixtureCopy(opts: {
  readonly mode: RetainedBuildFixtureMode;
  readonly read: () => Promise<string>;
  readonly record: RetainedBuildFixtureEvidence;
}): Promise<void> {
  await opts.record(opts.mode, "copy-begin");
  const text = await opts.read();
  await opts.record(opts.mode, "copy-captured", new TextEncoder().encode(text));
  assertRetainedBuildFixtureCopy({ mode: opts.mode, text });
  await opts.record(opts.mode, "copy-qualified");
}
