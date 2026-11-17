import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import { exec } from "../lib/shell.ts";
import type { RuntimeUpOptions } from "./runtime-backend.ts";

const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/:@+[\]-]{0,511}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}\s*$/;
const IMAGE_LIST_SEPARATOR = /\s+/;
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/;
const VOLUME_FORMAT =
  '{"Name":{{json .Name}},"Driver":{{json .Driver}},"Options":{{json .Options}},"Labels":{{json .Labels}}}';
export interface UnattendedTrustedBind {
  readonly source: string;
  readonly target: string;
  readonly readOnly: true;
}
export interface UnattendedNamedVolume {
  readonly name: string;
  readonly key: string;
  readonly project: string;
}
interface ModelSources {
  readonly binds: readonly UnattendedTrustedBind[];
  readonly images: readonly string[];
  readonly volumes: readonly UnattendedNamedVolume[];
}
export interface UnattendedInspection {
  readonly binds: readonly UnattendedTrustedBind[];
  readonly exitCode: number;
  readonly volumes: readonly UnattendedNamedVolume[];
}

function refuseSources(): never {
  throw new HackCliError({
    code: "E_PERMISSION",
    message:
      "Autostart cannot prove that the resolved project uses only ordinary engine storage. Run hack up manually.",
    detail: { reason: "compose_inputs_require_manual_start" },
  });
}
function emptyOptions(value: unknown): boolean {
  return value === null || (isRecord(value) && Object.keys(value).length === 0);
}
function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function namedVolume(
  source: string,
  project: unknown,
  definitions: Record<string, unknown>
): UnattendedNamedVolume {
  if (typeof project !== "string") {
    refuseSources();
  }
  const definition = definitions[source];
  const name = `${project}_${source}`;
  if (
    !isRecord(definition) ||
    definition.name !== name ||
    !VOLUME_NAME.test(name)
  ) {
    refuseSources();
  }
  if (
    (definition.driver !== undefined && definition.driver !== "local") ||
    (definition.external !== undefined && definition.external !== false) ||
    (definition.driver_opts !== undefined &&
      !emptyOptions(definition.driver_opts))
  ) {
    refuseSources();
  }
  return { name, key: source, project };
}
function authenticatedBind(
  mount: Record<string, unknown>,
  allowed: readonly UnattendedTrustedBind[]
): UnattendedTrustedBind {
  const trusted = allowed.find(
    (entry) =>
      entry.source === mount.source &&
      entry.target === mount.target &&
      entry.readOnly === true &&
      mount.read_only === true
  );
  if (
    !trusted ||
    (mount.bind !== undefined &&
      (!isRecord(mount.bind) ||
        Object.keys(mount.bind).some((key) => key !== "create_host_path"))) ||
    mount.volume !== undefined
  ) {
    refuseSources();
  }
  return trusted;
}

function serviceVolumes(
  service: Record<string, unknown>,
  definitions: Record<string, unknown>,
  project: unknown,
  trustedBinds: readonly UnattendedTrustedBind[],
  usedBinds: Map<string, UnattendedTrustedBind>
): readonly UnattendedNamedVolume[] {
  for (const key of [
    "configs",
    "secrets",
    "volumes_from",
    "label_file",
    "credential_spec",
  ]) {
    if (service[key] !== undefined) {
      refuseSources();
    }
  }
  if (service.volumes === undefined) {
    return [];
  }
  if (!Array.isArray(service.volumes)) {
    refuseSources();
  }
  const volumes: UnattendedNamedVolume[] = [];
  for (const mount of service.volumes) {
    if (!isRecord(mount)) {
      refuseSources();
    }
    if (mount.type === "bind") {
      const trusted = authenticatedBind(mount, trustedBinds);
      usedBinds.set(trusted.target, trusted);
      continue;
    }
    if (mount.type === "tmpfs" && mount.source === undefined) {
      continue;
    }
    if (mount.type !== "volume") {
      refuseSources();
    }
    if (mount.source === undefined) {
      continue;
    }
    if (typeof mount.source !== "string") {
      refuseSources();
    }
    volumes.push(namedVolume(mount.source, project, definitions));
  }
  return volumes;
}
/** Resolved models may contain sensitive internals; never log or persist any part of them. */
function modelSources(
  value: unknown,
  trustedBinds: readonly UnattendedTrustedBind[]
): ModelSources | undefined {
  if (!(isRecord(value) && isRecord(value.services))) {
    return undefined;
  }
  if (
    (isRecord(value.configs) && Object.keys(value.configs).length > 0) ||
    (isRecord(value.secrets) && Object.keys(value.secrets).length > 0)
  ) {
    refuseSources();
  }
  const definitions = isRecord(value.volumes) ? value.volumes : {};
  const binds = new Map<string, UnattendedTrustedBind>();
  const images = new Set<string>();
  const volumes = new Map<string, UnattendedNamedVolume>();
  for (const service of Object.values(value.services)) {
    if (!isRecord(service) || typeof service.image !== "string") {
      return undefined;
    }
    images.add(service.image);
    for (const volume of serviceVolumes(
      service,
      definitions,
      value.name,
      trustedBinds,
      binds
    )) {
      volumes.set(volume.name, volume);
    }
  }
  if (
    images.size > 256 ||
    volumes.size > 256 ||
    [...images].some((image) => !IMAGE_REFERENCE.test(image))
  ) {
    return undefined;
  }
  return {
    images: [...images],
    volumes: [...volumes.values()],
    binds: [...binds.values()],
  };
}
function probeFor(
  opts: Pick<RuntimeUpOptions, "cwd" | "env">,
  timeoutMs: number
) {
  const deadline = Date.now() + Math.min(timeoutMs, 15_000);
  return async (args: readonly string[], maxStdoutBytes = 65_536) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { exitCode: 124, stdout: "", stderr: "" };
    }
    const result = await exec(args, {
      cwd: opts.cwd,
      env: opts.env,
      stdin: "ignore",
      timeoutMs: remaining,
      maxStdoutBytes,
      maxStderrBytes: 4096,
      forwardSignals: true,
    });
    // Bounded captures preserve bytes as Latin-1; Compose emits UTF-8 JSON.
    return {
      ...result,
      stdout: new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(result.stdout, "latin1")
      ),
      stderr: new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(result.stderr, "latin1")
      ),
    };
  };
}
type Probe = ReturnType<typeof probeFor>;
async function imagePresent(image: string, probe: Probe): Promise<number> {
  const reference =
    image.includes("@") || image.slice(image.lastIndexOf("/") + 1).includes(":")
      ? image
      : `${image}:latest`;
  const result = await probe([
    "docker",
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    reference,
  ]);
  if (result.exitCode === 0 && IMAGE_ID.test(result.stdout)) {
    return 0;
  }
  if (
    result.exitCode === 1 &&
    result.stdout.trim() === "" &&
    result.stderr.trim() ===
      `Error response from daemon: No such image: ${reference}`
  ) {
    throw new HackCliError({
      code: "E_PERMISSION",
      message:
        "Autostart requires prepared local images. Run hack up manually before retrying.",
      detail: { reason: "image_requires_manual_start" },
    });
  }
  return result.exitCode || 1;
}

/** Require prepared local images without permitting a registry pull or build. */
export async function inspectUnattendedImages(opts: {
  readonly composeArgs: readonly string[];
  readonly cwd: string;
  readonly env?: Record<string, string>;
}): Promise<number> {
  const probe = probeFor({ cwd: opts.cwd, env: opts.env }, 15_000);
  const result = await probe([...opts.composeArgs, "config", "--images"]);
  if (result.exitCode !== 0) {
    return result.exitCode;
  }
  const images = [...new Set(result.stdout.trim().split(IMAGE_LIST_SEPARATOR))];
  if (
    images.length === 0 ||
    images.length > 256 ||
    images.some((image) => !IMAGE_REFERENCE.test(image))
  ) {
    return 1;
  }
  for (const image of images) {
    const code = await imagePresent(image, probe);
    if (code !== 0) {
      return code;
    }
  }
  return 0;
}
function resolvedModelHasBinds(value: unknown): boolean {
  if (!(isRecord(value) && isRecord(value.services))) {
    return false;
  }
  return Object.values(value.services).some(
    (service) =>
      isRecord(service) &&
      Array.isArray(service.volumes) &&
      service.volumes.some((mount) => isRecord(mount) && mount.type === "bind")
  );
}

/** Model and image probes run after the caller's unattended eligibility and intent guard. */
export async function inspectUnattendedInputs(
  opts: RuntimeUpOptions,
  composeArgs: readonly string[],
  timeoutMs: number
): Promise<UnattendedInspection> {
  try {
    const probe = probeFor(opts, timeoutMs);
    const config = await probe(
      [...composeArgs, "config", "--format", "json"],
      1024 * 1024
    );
    if (config.exitCode !== 0) {
      return { exitCode: config.exitCode, volumes: [], binds: [] };
    }
    const model = json(config.stdout);
    const authenticated = resolvedModelHasBinds(model)
      ? ((await opts.unattendedTrustedBinds?.()) ?? [])
      : [];
    const sources = modelSources(model, authenticated);
    if (!sources) {
      return { exitCode: 1, volumes: [], binds: [] };
    }
    for (const image of sources.images) {
      const code = await imagePresent(image, probe);
      if (code !== 0) {
        return { exitCode: code, volumes: [], binds: [] };
      }
    }
    return { exitCode: 0, volumes: sources.volumes, binds: sources.binds };
  } catch (error: unknown) {
    if (error instanceof HackCliError) {
      throw error;
    }
    return { exitCode: 1, volumes: [], binds: [] };
  }
}
async function volumeSafe(
  volume: UnattendedNamedVolume,
  probe: Probe
): Promise<number> {
  const result = await probe([
    "docker",
    "volume",
    "inspect",
    "--format",
    VOLUME_FORMAT,
    volume.name,
  ]);
  if (result.exitCode !== 0) {
    const missing = [
      `Error response from daemon: get ${volume.name}: no such volume`,
      `Error response from daemon: No such volume: ${volume.name}`,
    ];
    return result.exitCode === 1 &&
      result.stdout.trim() === "" &&
      missing.includes(result.stderr.trim())
      ? 0
      : result.exitCode || 1;
  }
  const value = json(result.stdout);
  if (
    !isRecord(value) ||
    value.Name !== volume.name ||
    value.Options === undefined ||
    typeof value.Driver !== "string"
  ) {
    return 1;
  }
  if (
    value.Driver !== "local" ||
    !emptyOptions(value.Options) ||
    !isRecord(value.Labels) ||
    value.Labels["com.docker.compose.project"] !== volume.project ||
    value.Labels["com.docker.compose.volume"] !== volume.key
  ) {
    refuseSources();
  }
  return 0;
}
/** Recheck existing engine storage as late as possible, before create and again before start. */
export async function inspectUnattendedStorage(
  opts: RuntimeUpOptions,
  volumes: readonly UnattendedNamedVolume[],
  binds: readonly UnattendedTrustedBind[],
  timeoutMs: number
): Promise<number> {
  try {
    if (binds.length > 0) {
      const authenticated = (await opts.unattendedTrustedBinds?.()) ?? [];
      if (
        binds.some(
          (used) =>
            !authenticated.some(
              (entry) =>
                entry.source === used.source &&
                entry.target === used.target &&
                entry.readOnly === true
            )
        )
      ) {
        refuseSources();
      }
    }
    const probe = probeFor(opts, timeoutMs);
    for (const volume of volumes) {
      const code = await volumeSafe(volume, probe);
      if (code !== 0) {
        return code;
      }
    }
    return 0;
  } catch (error: unknown) {
    if (error instanceof HackCliError) {
      throw error;
    }
    return 1;
  }
}
