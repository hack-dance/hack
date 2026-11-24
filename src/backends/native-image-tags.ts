import { CliUsageError } from "../cli/command.ts";
import { ClosedCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  NATIVE_IMAGE_ENSURE_TIMEOUT_MS,
  NativeImageBlocker,
  nativeImageBlockerDetail,
  nativeImagePolicyArgs,
  nativeImageRegistryReason,
} from "./native-image-policy.ts";
import { prepareNativeProjectAdaptation } from "./native-project-adaptation.ts";
import {
  admitNativeProjectBuilds,
  nativeBuildBases,
  nativeServiceActive,
  refuseManagedSecretBuildArguments,
} from "./native-project-builds.ts";
import { admitNativeProjectImages } from "./native-project-image-admission.ts";
import {
  prepareNativeProjectInput,
  readNativeComposeBytes,
} from "./native-project-input.ts";
import {
  ensuredPlatformAccepted,
  nativeEmulationPolicy,
  nativeEnsureImageArgs,
} from "./native-project-platform.ts";
import { selectNativeEnvFile } from "./native-project-selection.ts";
import { resolveNativeAdaptationSelection } from "./native-project-settings.ts";
import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const UP_BUILD_REFUSAL = /^Native foreground up cannot build /;
const DISPLAY_IDENTITY = /^[A-Za-z0-9._:/@-]{1,512}$/;
const TAG_REFERENCE = /^[A-Za-z0-9._:/-]{1,512}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;

type Project = Parameters<typeof prepareNativeProjectInput>[0];

function services(value: unknown): Record<string, unknown> {
  if (!(isRecord(value) && isRecord(value.services))) {
    throw new CliUsageError(
      "Native image selection requires a Compose services mapping."
    );
  }
  return value.services;
}

export function offlineTagNotice(reply: unknown): string | undefined {
  if (!(isRecord(reply) && isRecord(reply.tag_resolution))) {
    return;
  }
  const tag = reply.tag_resolution;
  if (tag.source !== "offline") {
    return;
  }
  const reason =
    tag.fallback_reason === undefined
      ? "registry lookup disabled"
      : (nativeImageRegistryReason(tag.fallback_reason) ??
        "registry refresh failed");
  const time =
    typeof tag.resolved_at_unix_seconds === "number"
      ? new Date(tag.resolved_at_unix_seconds * 1000)
      : undefined;
  if (!(time && Number.isFinite(time.getTime()))) {
    return "Registry lookup unavailable; using the loaded image";
  }
  return `${reason}, using the loaded image resolved ${time.toISOString()}`;
}

export async function pullNativeProjectImages(opts: {
  readonly project: Project;
  readonly runtime: NativeRuntimeSelection;
  readonly profiles: readonly string[];
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<readonly unknown[]> {
  const input = await prepareNativeProjectInput({
    ...opts.project,
    profiles: opts.profiles,
    env: process.env,
  });
  const adaptation = await resolveNativeAdaptationSelection({
    env: process.env,
    projectDir: opts.project.projectDir,
  });
  const adapted = await prepareNativeProjectAdaptation({
    input,
    path: selectNativeEnvFile({
      selection: adaptation,
      envName: input.effectiveEnvName,
    }),
  });
  const specs = Object.entries(
    services(JSON.parse(adapted.normalizedComposeJson))
  ).flatMap(([name, spec]) =>
    isRecord(spec) && nativeServiceActive(spec, opts.profiles)
      ? [[name, spec] as const]
      : []
  );
  const seen = new Set<string>();
  const pins = new Map<string, string>();
  const results: unknown[] = [];
  const invoke = opts.invoke ?? invokeNativeRuntime;
  const policyArgs = nativeImagePolicyArgs();
  const canonical = await admitNativeProjectImages({
    runtime: opts.runtime,
    projectRoot: opts.project.projectRoot,
    specs: Object.fromEntries(specs),
    invoke,
  });

  const images = specs.flatMap(([name, spec]) =>
    typeof spec.image === "string"
      ? [
          {
            image: spec.image,
            policy: nativeEmulationPolicy(adapted.amd64Emulation, name),
          },
        ]
      : []
  );
  const pull = async ({ image, policy }: (typeof images)[number]) => {
    const reference = canonical.get(image) ?? image;
    const selection = `${reference}\n${policy ?? "native"}`;
    if (seen.has(selection)) {
      return;
    }
    const pin = pins.get(reference);
    const args = nativeEnsureImageArgs(reference, policy);
    const result = await invoke({
      runtime: opts.runtime,
      cwd: opts.project.projectRoot,
      args: [
        ...args,
        ...policyArgs,
        "--image-tag-mode",
        "refresh",
        ...(pin ? ["--command-image-pin", pin] : []),
      ],
      timeoutMs: NATIVE_IMAGE_ENSURE_TIMEOUT_MS,
    }).catch((error: unknown) => {
      if (error instanceof NativeRuntimeRequestError) {
        const reason =
          nativeImageRegistryReason(error.nativeCauseCode) ??
          (error.nativeCode === "registry_image_not_found"
            ? nativeImageRegistryReason("registry_http_404")
            : undefined);
        throw new ClosedCliError(
          `Native pull could not confirm ${reference}: ${reason ?? error.message}`
        );
      }
      throw error;
    });
    if (
      !isRecord(result) ||
      result.phase !== "content-id-verified" ||
      typeof result.image_id !== "string" ||
      !IMAGE_ID.test(result.image_id) ||
      typeof result.pinned_reference !== "string" ||
      !ensuredPlatformAccepted(result.platform, policy)
    ) {
      throw new ClosedCliError(
        "Native pull did not confirm the requested image in the guest."
      );
    }
    const expected = pin ?? reference;
    const actual = IMAGE_ID.test(reference)
      ? result.image_id
      : result.pinned_reference;
    if (
      (IMAGE_ID.test(reference) || expected.includes("@")) &&
      actual !== expected
    ) {
      const reported = DISPLAY_IDENTITY.test(actual)
        ? actual
        : "(invalid identity)";
      throw new ClosedCliError(
        `Native pull requested ${expected} but the guest confirmed ${reported}.`
      );
    }
    if (!(IMAGE_ID.test(reference) || reference.includes("@") || pin)) {
      pins.set(reference, result.pinned_reference);
    }
    seen.add(selection);
    results.push(result);
  };
  for (const image of images) {
    await pull(image);
  }
  let bases: readonly string[];
  try {
    const builds = admitNativeProjectBuilds({
      services: Object.fromEntries(specs),
      projectRoot: opts.project.projectRoot,
      composeFile: opts.project.composeFile,
      enabled: true,
    });
    refuseManagedSecretBuildArguments({
      builds,
      managedSecretValues: input.managedSecretValues ?? [],
    });
    bases = await nativeBuildBases({
      projectRoot: opts.project.projectRoot,
      runtime: opts.runtime,
      builds,
      invoke,
    });
  } catch (error) {
    const detail =
      error instanceof Error
        ? error.message
        : "Build bases could not be inspected.";
    throw new ClosedCliError(
      `Native pull could not confirm build bases: ${detail.replace(UP_BUILD_REFUSAL, "")}`
    );
  }
  for (const base of bases) {
    await pull({ image: base, policy: undefined });
  }
  return results;
}

export type NativeImageTagStatus = {
  reference: string;
  registry: string;
  source_digest: string;
  resolved_at_unix_seconds: number;
  aliases: readonly string[];
  selections: readonly {
    policy: string;
    platform: string;
    image_id: string;
    source_digest?: string;
    resolved_at_unix_seconds?: number;
  }[];
};

function status(value: unknown): value is NativeImageTagStatus {
  return (
    isRecord(value) &&
    typeof value.reference === "string" &&
    typeof value.registry === "string" &&
    typeof value.source_digest === "string" &&
    typeof value.resolved_at_unix_seconds === "number" &&
    Number.isSafeInteger(value.resolved_at_unix_seconds) &&
    value.resolved_at_unix_seconds >= 0 &&
    value.resolved_at_unix_seconds <= 8_640_000_000_000 &&
    Array.isArray(value.aliases) &&
    value.aliases.every((alias: unknown) => typeof alias === "string") &&
    Array.isArray(value.selections) &&
    value.selections.every(
      (selection: unknown) =>
        isRecord(selection) &&
        typeof selection.policy === "string" &&
        typeof selection.platform === "string" &&
        typeof selection.image_id === "string" &&
        IMAGE_ID.test(selection.image_id) &&
        (selection.source_digest === undefined ||
          (typeof selection.source_digest === "string" &&
            IMAGE_ID.test(selection.source_digest))) &&
        (selection.resolved_at_unix_seconds === undefined ||
          (typeof selection.resolved_at_unix_seconds === "number" &&
            Number.isSafeInteger(selection.resolved_at_unix_seconds) &&
            selection.resolved_at_unix_seconds >= 0 &&
            selection.resolved_at_unix_seconds <= 8_640_000_000_000))
    )
  );
}

type ReadTagStatuses = {
  readonly projectRoot: string;
  readonly runtime: NativeRuntimeSelection;
  readonly invoke?: typeof invokeNativeRuntime;
};

function isTag(image: unknown): image is string {
  return (
    typeof image === "string" &&
    TAG_REFERENCE.test(image) &&
    !IMAGE_ID.test(image)
  );
}

async function readTagStatuses(
  opts: ReadTagStatuses,
  references: readonly string[]
): Promise<readonly NativeImageTagStatus[]> {
  if (!references.length) {
    return [];
  }
  const result = await (opts.invoke ?? invokeNativeRuntime)({
    runtime: opts.runtime,
    cwd: opts.projectRoot,
    args: ["runtime", "image-tag-status", "--json", ...references],
  });
  if (!(Array.isArray(result) && result.every(status))) {
    throw new ClosedCliError(
      "Native image tag status returned an invalid response."
    );
  }
  return result;
}

export async function nativeImageBlocker(
  opts: ReadTagStatuses & {
    readonly missing: string;
    readonly downloading?: boolean;
    readonly buildBase?: true;
    readonly reason?: string;
    readonly references: readonly string[];
    readonly confirmed: ReadonlySet<string>;
  }
): Promise<NativeImageBlocker> {
  const result = await (opts.invoke ?? invokeNativeRuntime)({
    runtime: opts.runtime,
    cwd: opts.projectRoot,
    args: [
      "runtime",
      "image-tag-status",
      "--present",
      "--json",
      ...opts.references,
    ],
    timeoutMs: 10_000,
  }).catch(() => null);
  let present: readonly string[] | null = opts.confirmed.size
    ? [...opts.confirmed].slice(0, 32)
    : null;
  if (
    Array.isArray(result) &&
    result.every((image) => typeof image === "string")
  ) {
    present = [...new Set([...opts.confirmed, ...result])].slice(0, 32);
  }
  const observation = {
    missing: opts.missing,
    present,
    ...(opts.downloading ? { downloading: true as const } : {}),
    ...(opts.buildBase ? { buildBase: true as const } : {}),
    ...(nativeImageRegistryReason(opts.reason) ? { reason: opts.reason } : {}),
  };
  return new NativeImageBlocker(
    nativeImageBlockerDetail(observation)
      ? observation
      : { missing: "unknown", present: null }
  );
}

export async function nativeImageTagStatuses(
  opts: ReadTagStatuses & { readonly composeFile: string }
): Promise<readonly NativeImageTagStatus[]> {
  // Graph observation remains available if the current Compose file is missing
  // or malformed. An existing graph need not match current editable inputs.
  const spec = await readNativeComposeBytes(opts.composeFile)
    .then((bytes) => services(Bun.YAML.parse(new TextDecoder().decode(bytes))))
    .catch(() => ({}));
  const references = new Set(
    Object.values(spec).flatMap((service) =>
      isRecord(service) && isTag(service.image) ? [service.image] : []
    )
  );
  // Tag metadata is supplemental to the independently observed project status.
  return await readTagStatuses(opts, [...references]).catch(() => []);
}
