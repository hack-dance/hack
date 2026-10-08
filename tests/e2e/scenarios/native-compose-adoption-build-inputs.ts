import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../../src/lib/guards.ts";
import { adoptionDependencyReadAllowed } from "./native-compose-adoption-dependency-inputs.ts";
import {
  type AdoptionDependencyFirstPrepare,
  adoptionDependencyStagedReadAllowed,
} from "./native-compose-adoption-dependency-staged-read.ts";

export type RetainedBuildFixtureMode = "root-specific" | "hack-default";
export const RETAINED_BUILD_BASE_TAG = "postgres:17.6-alpine";
export const RETAINED_BUILD_IMAGE_OWNER = "hack.e2e.retained-build.owner";
export const RETAINED_BUILD_IMAGE_FORMAT = `{"id":{{json .Id}},"created":{{json .Created}},"owner":{{json (index .Config.Labels "${RETAINED_BUILD_IMAGE_OWNER}")}},"stage":{{json (index .Config.Labels "hack.e2e.retained-build.stage")}},"tags":{{json .RepoTags}},"digests":{{json .RepoDigests}}}`;
const ID = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const BIRTH = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/;
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOKEN = /^[a-f0-9]{32}$/;
const CONTAINER_IMAGE_FORMAT =
  '{"id":{{json .Id}},"image":{{json .Image}},"reference":{{json .Config.Image}},"createdAt":{{json .Created}}}';
const IMAGE_BIRTH_FORMAT = '{"id":{{json .Id}},"createdAt":{{json .Created}}}';

function refuse(): never {
  throw new Error(
    "Retained build fixture source or ownership refused; values omitted."
  );
}
function hash(bytes: string | Uint8Array) {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}
function marker(mode: RetainedBuildFixtureMode) {
  return `retained-build-${mode}\n`;
}
/** Closed authored definition: root/specific/target and default .hack are independently exercised. */
export function retainedBuildFixtureDefinition(mode: RetainedBuildFixtureMode) {
  return mode === "root-specific"
    ? {
        context: "..",
        dockerfile: ".hack/toolchain/Dockerfile",
        target: "retained",
      }
    : {};
}
export function retainedBuildFixtureMarker(
  root: string,
  mode: RetainedBuildFixtureMode
) {
  return join(
    root,
    mode === "root-specific" ? ".hack/toolchain/run.sh" : ".hack/data-marker"
  );
}
export function retainedBuildFixtureCopiedFiles(
  mode: RetainedBuildFixtureMode
) {
  return mode === "root-specific"
    ? [
        { path: ".hack/toolchain/run.sh", hash: hash(marker(mode)) },
        { path: "mise.toml", hash: hash("# synthetic retained build input\n") },
      ]
    : [{ path: "data-marker", hash: hash(marker(mode)) }];
}
/** The real builder's complete copied file list and hashes must equal this explicit fixture oracle. */
export function assertRetainedBuildFixtureCopy(opts: {
  readonly mode: RetainedBuildFixtureMode;
  readonly text: string;
}) {
  const expected = retainedBuildFixtureCopiedFiles(opts.mode)
    .map(({ path, hash: digest }) => `${path} ${digest}`)
    .sort()
    .join("\n");
  if (opts.text.trim() !== expected) {
    refuse();
  }
}
export const RETAINED_BUILD_COPY_ORACLE =
  'set -eu; cd /nc04-context; find . -type f | LC_ALL=C sort | while IFS= read -r p; do h=$(sha256sum "$p"); printf \'%s %s\\n\' "${p#./}" "${h%% *}"; done';

/** Fixture authoring only. These files live outside all managed-output directories. */
export async function prepareRetainedBuildFixtureSources(opts: {
  readonly root: string;
  readonly name: string;
  readonly mode: RetainedBuildFixtureMode;
}) {
  if (!NAME.test(opts.name)) {
    refuse();
  }
  const rootMode = opts.mode === "root-specific";
  const context = rootMode ? opts.root : join(opts.root, ".hack");
  const definition = rootMode ? ".hack/toolchain/Dockerfile" : "Dockerfile";
  await mkdir(join(opts.root, ".hack/toolchain"), { recursive: true });
  await Bun.write(
    retainedBuildFixtureMarker(opts.root, opts.mode),
    marker(opts.mode)
  );
  const dockerfile = [
    `FROM ${RETAINED_BUILD_BASE_TAG} AS retained`,
    `LABEL ${RETAINED_BUILD_IMAGE_OWNER}="${opts.name}" hack.e2e.retained-build.stage="retained"`,
    "COPY . /nc04-context",
    ...(rootMode
      ? [
          `FROM ${RETAINED_BUILD_BASE_TAG} AS wrong-final-stage`,
          "LABEL hack.e2e.retained-build.stage=wrong",
        ]
      : []),
    "",
  ].join("\n");
  await Bun.write(join(context, definition), dockerfile);
  if (rootMode) {
    await Bun.write(
      join(opts.root, "mise.toml"),
      "# synthetic retained build input\n"
    );
    // The shadowed root ignore deliberately selects a different file. Both raw
    // inputs remain privately pinned, while only the specific rules feed COPY.
    await Bun.write(join(opts.root, "wrong-marker"), "shadowed-root-ignore\n");
    await Bun.write(join(opts.root, ".dockerignore"), "**\n!wrong-marker\n");
    await Bun.write(
      join(context, `${definition}.dockerignore`),
      [
        "**",
        "!mise.toml",
        "!.hack",
        "!.hack/toolchain",
        "!.hack/toolchain/Dockerfile",
        "!.hack/toolchain/run.sh",
        // Parent negation also admits future private output; close every owned
        // frontier rather than pretending the raw toolchain whitelist is safe.
        ".hack/.internal",
        ".hack/.branch",
        ".hack/hack.config.json",
        ".hack/docker-compose.yml",
        ".hack/hack.project.json",
        ".hack/toolchain/Dockerfile",
        ".hack/toolchain/Dockerfile.dockerignore",
        "",
      ].join("\n")
    );
  } else {
    await Bun.write(join(context, ".dockerignore"), "**\n!data-marker\n");
  }
}

/** Explicit fixture paths, not an alternative general build-context acquisition owner. */
export async function retainedBuildFixtureSourceSnapshot(opts: {
  readonly root: string;
  readonly mode: RetainedBuildFixtureMode;
}) {
  const paths =
    opts.mode === "root-specific"
      ? [
          "mise.toml",
          ".dockerignore",
          "wrong-marker",
          ".hack/toolchain/Dockerfile",
          ".hack/toolchain/Dockerfile.dockerignore",
          ".hack/toolchain/run.sh",
        ]
      : [".hack/Dockerfile", ".hack/.dockerignore", ".hack/data-marker"];
  const result = [];
  for (const path of paths) {
    const selected = join(opts.root, path);
    const info = await lstat(selected);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o022) !== 0
    ) {
      refuse();
    }
    result.push({
      path,
      dev: info.dev,
      ino: info.ino,
      mode: info.mode,
      hash: hash(await readFile(selected)),
    });
  }
  return JSON.stringify(result);
}

export type RetainedFixtureImage = {
  readonly id: string;
  readonly created: string;
  readonly reference: string;
  readonly tag: string;
  readonly owner: string;
};
/** Capture no old/foreign image removal authority, even when its tag happens to match. */
export function retainedBuildFixtureImage(opts: {
  readonly value: unknown;
  readonly reference: string;
  readonly owner: string;
  readonly originalImageIds: readonly string[];
}): RetainedFixtureImage {
  const { value, reference, owner, originalImageIds } = opts;
  if (
    !(
      isRecord(value) &&
      Object.keys(value).sort().join() ===
        "created,digests,id,owner,stage,tags" &&
      typeof value.id === "string" &&
      IMAGE.test(value.id) &&
      !originalImageIds.includes(value.id) &&
      originalImageIds.every((id) => IMAGE.test(id)) &&
      typeof value.created === "string" &&
      BIRTH.test(value.created) &&
      Number.isFinite(Date.parse(value.created)) &&
      NAME.test(owner) &&
      value.owner === owner &&
      value.stage === "retained" &&
      Array.isArray(value.tags) &&
      value.tags.length === 1 &&
      (value.tags[0] === reference ||
        value.tags[0] === `${reference}:latest`) &&
      (value.digests === null ||
        (Array.isArray(value.digests) && value.digests.length === 0))
    )
  ) {
    refuse();
  }
  return Object.freeze({
    id: value.id,
    created: value.created,
    reference,
    tag: value.tags[0],
    owner,
  });
}
export function assertRetainedFixtureImageUnchanged(opts: {
  readonly current: RetainedFixtureImage;
  readonly captured: RetainedFixtureImage;
}) {
  if (JSON.stringify(opts.current) !== JSON.stringify(opts.captured)) {
    refuse();
  }
}

type BuildReadScope = {
  readonly args: readonly string[];
  readonly projectRoot: string;
  readonly project: string;
  readonly containerIds: readonly string[];
  readonly networkId: string;
  readonly volumeName: string;
  readonly generationId?: unknown;
  readonly images: readonly {
    readonly id: string;
    readonly reference: string;
  }[];
};
function imageQueryAsHash(opts: BuildReadScope): readonly string[] | null {
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
  if (
    opts.args.length !== prefix.length + 5 ||
    JSON.stringify(opts.args.slice(0, prefix.length)) !==
      JSON.stringify(prefix) ||
    JSON.stringify(opts.args.slice(-3, -1)) !==
      JSON.stringify(["--no-env-resolution", "--images"]) ||
    opts.args.at(-4) !== "config" ||
    !["db", "worker"].includes(opts.args.at(-1) ?? "")
  ) {
    return null;
  }
  return [...opts.args.slice(0, -2), "--hash", "*"];
}
/** Closed read forwarding extends existing public metadata formats only with exact build-image facts. */
export function retainedBuildFixtureReadAllowed(opts: BuildReadScope): boolean {
  if (adoptionDependencyReadAllowed(opts)) {
    return true;
  }
  const imageQuery = imageQueryAsHash(opts);
  if (imageQuery) {
    return adoptionDependencyReadAllowed({ ...opts, args: imageQuery });
  }
  const { args } = opts;
  if (args.length !== 5 || args[1] !== "inspect" || args[2] !== "--format") {
    return false;
  }
  if (args[0] === "container") {
    return (
      args[3] === CONTAINER_IMAGE_FORMAT &&
      opts.containerIds.includes(args[4] ?? "") &&
      opts.containerIds.every((id) => ID.test(id))
    );
  }
  return (
    args[0] === "image" &&
    args[3] === IMAGE_BIRTH_FORMAT &&
    opts.images.some(
      ({ id, reference }) =>
        IMAGE.test(id) && [id, reference].includes(args[4] ?? "")
    )
  );
}
/** First staged images query uses the same strict file/store/receipt check as the canonical staged hash query. */
export async function retainedBuildFixtureStagedReadAllowed(opts: {
  readonly scope: BuildReadScope;
  readonly first: AdoptionDependencyFirstPrepare;
}) {
  const args = imageQueryAsHash(opts.scope) ?? opts.scope.args;
  return await adoptionDependencyStagedReadAllowed({
    args,
    project: opts.scope.project,
    first: opts.first,
  });
}
/** No generic engine passthrough: the saved journal, complete IDs and current daemon precede each effect. */
export function retainedBuildFixtureMutationAllowed(opts: {
  readonly args: readonly string[];
  readonly receipt: unknown;
  readonly ids: readonly string[];
  readonly services: readonly string[];
}) {
  const { args, receipt, ids, services } = opts;
  if (
    !(
      args.length === 3 &&
      args[0] === "container" &&
      ["start", "stop"].includes(args[1] ?? "") &&
      ids.length === 2 &&
      new Set(ids).size === 2 &&
      ids.every((id) => ID.test(id)) &&
      ids.includes(args[2] ?? "") &&
      services.length === 2 &&
      JSON.stringify([...services].sort()) ===
        JSON.stringify(["db", "worker"]) &&
      isRecord(receipt) &&
      receipt.adoption_receipt_version === 9 &&
      isRecord(receipt.pendingOperation) &&
      receipt.pendingOperation.operation === args[1] &&
      Array.isArray(receipt.pendingOperation.services) &&
      JSON.stringify([...receipt.pendingOperation.services].sort()) ===
        JSON.stringify([...services].sort()) &&
      isRecord(receipt.pendingOperation.generation) &&
      typeof receipt.pendingOperation.generation.id === "string" &&
      TOKEN.test(receipt.pendingOperation.generation.id)
    )
  ) {
    return false;
  }
  const selection =
    args[1] === "stop" && receipt.publication === null
      ? receipt.prepared
      : isRecord(receipt.publication) && receipt.publication.phase === "active"
        ? receipt.publication.generation
        : null;
  return (
    isRecord(selection) &&
    JSON.stringify(selection) ===
      JSON.stringify(receipt.pendingOperation.generation)
  );
}
