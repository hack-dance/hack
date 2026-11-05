import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import { resolveUserHomeDir } from "../lib/home-dir.ts";
import { runNativePrivateCli } from "./native-private-cli.ts";
import type {
  NativeManagedFile,
  NativeProjectInput,
} from "./native-project-input.ts";

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ADC_BYTES = 16 * 1024;
const MAX_TARGET = 1024;
const MEMBER = "gcloud-adc.json";
const ADC_RELATIVE = ".config/gcloud/application_default_credentials.json";
const SELECTOR = "GOOGLE_APPLICATION_CREDENTIALS";
/** Host-path, metadata and executable selectors that would bypass the delivered file. */
const REFUSED_SELECTORS = [
  "CLOUDSDK_CONFIG",
  "CLOUDSDK_AUTH_ACCESS_TOKEN_FILE",
  "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
  "GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES",
  "GCE_METADATA_HOST",
  "GCE_METADATA_IP",
];
const RESERVED_ROOTS = ["/proc", "/sys", "/dev", "/run", "/var/run"];
const PRINTABLE = /^[\x20-\x7e]+$/;

/** Supported gcloud adapter modes. `file` delivers the ADC file itself. */
export type NativeGcloudMode = "file";
export type NativeGcloudSelection = { readonly mode: NativeGcloudMode };

function refused(): Error {
  return new HackCliError({
    code: "E_CONFIG_INVALID",
    message:
      "Native gcloud adaptation refused: verify application-default login, the supported read-only ADC mount and selectors; values omitted.",
  });
}
/** Distinct refusal for an absent CLI so the next step is clear; carries no output. */
class MissingGcloudCli extends HackCliError {}
function missingCli(): Error {
  return new MissingGcloudCli({
    code: "E_CONFIG_INVALID",
    message:
      "Native gcloud adaptation refused: application-default credentials require the gcloud CLI; values omitted.",
  });
}

/** Parse the explicit selector value; only `file` is accepted. */
export function parseNativeGcloudSelection(
  value: string | undefined
): NativeGcloudSelection | undefined {
  if (value === undefined || value === "") {
    return;
  }
  if (value !== "file") {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: "HACK_NATIVE_GCLOUD_ADC accepts only `file`.",
    });
  }
  return { mode: "file" };
}

function within(path: string, parent: string): boolean {
  return parent === "/" || path.startsWith(`${parent}/`);
}
/** Absolute, normalized container file path outside reserved runtime roots. */
function validTarget(target: unknown): target is string {
  return (
    typeof target === "string" &&
    target.length > 1 &&
    target.length <= MAX_TARGET &&
    target.startsWith("/") &&
    PRINTABLE.test(target) &&
    !target.includes("\\") &&
    target
      .slice(1)
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..") &&
    !RESERVED_ROOTS.some((root) => target === root || within(target, root))
  );
}

function mentionsAdc(value: unknown): boolean {
  return (
    typeof value === "string" &&
    (value.includes("gcloud") ||
      value.includes("application_default_credentials"))
  );
}

function shortAdcMount(
  value: string,
  sources: ReadonlySet<string>
): string | undefined {
  if (!mentionsAdc(value)) {
    return;
  }
  const [source, target, mode, extra] = value.split(":");
  if (
    !(source && sources.has(source) && validTarget(target)) ||
    mode !== "ro" ||
    extra !== undefined
  ) {
    throw refused();
  }
  return target;
}
function longAdcMount(
  value: Record<string, unknown>,
  sources: ReadonlySet<string>
): string | undefined {
  if (!(mentionsAdc(value.source) || mentionsAdc(value.target))) {
    return;
  }
  if (
    typeof value.source !== "string" ||
    !sources.has(value.source) ||
    !validTarget(value.target) ||
    value.type !== "bind" ||
    value.read_only !== true ||
    Object.keys(value).some(
      (key) => !["type", "source", "target", "read_only"].includes(key)
    )
  ) {
    throw refused();
  }
  return value.target;
}
/** Returns the container target of a recognized ADC mount, undefined for an unrelated mount. */
function adcMount(value: unknown, home: string): string | undefined {
  const sources = new Set([
    `~/${ADC_RELATIVE}`,
    `\${HOME}/${ADC_RELATIVE}`,
    `$HOME/${ADC_RELATIVE}`,
    join(home, ADC_RELATIVE),
  ]);
  if (typeof value === "string") {
    return shortAdcMount(value, sources);
  }
  if (!isRecord(value)) {
    throw refused();
  }
  return longAdcMount(value, sources);
}

function mountTarget(mount: unknown): string {
  if (typeof mount === "string") {
    const parts = mount.split(":");
    return (parts.length === 1 ? parts[0] : parts[1]) ?? "";
  }
  return isRecord(mount) && typeof mount.target === "string"
    ? mount.target
    : "";
}
function tmpfsEntries(value: unknown): readonly unknown[] {
  if (typeof value === "string") {
    return [value];
  }
  return Array.isArray(value) ? value : [];
}
/** Container targets claimed by other mounts and tmpfs entries; "" marks an unparsable one. */
function otherTargets(
  service: Record<string, unknown>,
  skip: unknown
): string[] {
  const volumes = Array.isArray(service.volumes) ? service.volumes : [];
  return [
    ...volumes.filter((mount) => mount !== skip).map(mountTarget),
    ...tmpfsEntries(service.tmpfs).map((entry) =>
      typeof entry === "string" ? (entry.split(":")[0] ?? "") : ""
    ),
  ];
}

function serviceEnvironment(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (isRecord(value)) {
    return { ...value };
  }
  if (!Array.isArray(value)) {
    throw refused();
  }
  const output: Record<string, unknown> = {};
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw refused();
    }
    const equal = entry.indexOf("=");
    const key = equal < 0 ? entry : entry.slice(0, equal);
    if (!KEY.test(key) || Object.hasOwn(output, key)) {
      throw refused();
    }
    output[key] = equal < 0 ? null : entry.slice(equal + 1);
  }
  return output;
}

/**
 * `GOOGLE_APPLICATION_CREDENTIALS`, when declared, must name exactly the mount
 * target; it is kept as a public value. Selectors that point elsewhere refuse.
 */
function applySelectors(
  environment: Record<string, unknown>,
  privateValues: Record<string, string>,
  target: string
): void {
  for (const key of REFUSED_SELECTORS) {
    if (Object.hasOwn(environment, key) || Object.hasOwn(privateValues, key)) {
      throw refused();
    }
  }
  const declared = Object.hasOwn(environment, SELECTOR);
  const managed = Object.hasOwn(privateValues, SELECTOR);
  if (managed) {
    if (privateValues[SELECTOR] !== target || environment[SELECTOR] !== null) {
      throw refused();
    }
    delete privateValues[SELECTOR];
    environment[SELECTOR] = target;
  } else if (declared && environment[SELECTOR] !== target) {
    throw refused();
  }
}

type Prepared = {
  readonly compose: Record<string, unknown> & {
    services: Record<string, unknown>;
  };
  readonly managed: Record<string, Record<string, string>>;
  readonly targets: ReadonlyMap<string, string>;
};

/** The single recognized ADC mount of one service, or undefined when it has none. */
function serviceAdcMount(
  service: Record<string, unknown>,
  home: string
): { readonly mount: unknown; readonly target: string } | undefined {
  if (service.volumes === undefined) {
    return;
  }
  if (!Array.isArray(service.volumes)) {
    throw refused();
  }
  const matches = service.volumes.flatMap((mount) => {
    const target = adcMount(mount, home);
    return target === undefined ? [] : [{ mount, target }];
  });
  if (matches.length > 1) {
    throw refused();
  }
  return matches[0];
}
function claimed(
  service: Record<string, unknown>,
  match: { readonly mount: unknown; readonly target: string },
  existing: readonly NativeManagedFile[]
): boolean {
  const { target } = match;
  return (
    otherTargets(service, match.mount).some(
      (other) =>
        other === "" ||
        other === target ||
        within(target, other) ||
        within(other, target)
    ) || existing.some((file) => file.target === target || file.name === MEMBER)
  );
}

function prepareServices(input: NativeProjectInput, home: string): Prepared {
  const compose: unknown = JSON.parse(input.normalizedComposeJson);
  if (!(isRecord(compose) && isRecord(compose.services))) {
    throw refused();
  }
  const services = compose.services;
  const managed: Record<string, Record<string, string>> = {
    ...input.managedEnvironment,
  };
  const targets = new Map<string, string>();
  for (const [name, service] of Object.entries(services)) {
    if (!isRecord(service)) {
      throw refused();
    }
    const match = serviceAdcMount(service, home);
    if (!match) {
      continue;
    }
    if (claimed(service, match, input.managedFiles?.[name] ?? [])) {
      throw refused();
    }
    service.volumes = Array.isArray(service.volumes)
      ? service.volumes.filter((mount) => mount !== match.mount)
      : [];
    const environment = serviceEnvironment(service.environment);
    const privateValues = { ...managed[name] };
    applySelectors(environment, privateValues, match.target);
    service.environment = environment;
    if (Object.keys(privateValues).length > 0) {
      managed[name] = privateValues;
    } else {
      delete managed[name];
    }
    targets.set(name, match.target);
  }
  if (targets.size === 0) {
    throw refused();
  }
  return { compose: { ...compose, services }, managed, targets };
}

type FileIdentity = string;
function identity(stat: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}): FileIdentity {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

/**
 * Read the fixed host ADC file: no symlink final component, a regular file owned
 * by this user, not group- or world-writable, 1..16 KiB, unchanged during the read.
 */
async function readAdc(
  path: string
): Promise<{ readonly bytes: Buffer; readonly identity: FileIdentity }> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o022) !== 0 ||
      before.size < 1 ||
      before.size > MAX_ADC_BYTES
    ) {
      throw refused();
    }
    const buffer = Buffer.alloc(MAX_ADC_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const after = await file.stat();
    if (bytesRead !== before.size || identity(after) !== identity(before)) {
      buffer.fill(0);
      throw refused();
    }
    const bytes = Buffer.from(buffer.subarray(0, bytesRead));
    buffer.fill(0);
    return { bytes, identity: identity(before) };
  } finally {
    await file.close();
  }
}
async function currentIdentity(path: string): Promise<FileIdentity> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    return identity(await file.stat());
  } finally {
    await file.close();
  }
}

function hasCredentialSource(value: unknown, depth = 0): boolean {
  if (depth > 16) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasCredentialSource(entry, depth + 1));
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, entry]) =>
      key === "credential_source" || hasCredentialSource(entry, depth + 1)
  );
}
function authorizedUser(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.type === "authorized_user" &&
    ["client_id", "client_secret", "refresh_token"].every(
      (key) => typeof value[key] === "string" && value[key] !== ""
    )
  );
}

/**
 * Admit only user credentials. `service_account` key files are refused by default
 * (long-lived private keys); external-account types refuse because their
 * credential sources name host files, URLs or executables absent in the guest.
 */
export function nativeGcloudCredentialType(bytes: Buffer): string {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw refused();
  }
  if (!isRecord(value) || hasCredentialSource(value)) {
    throw refused();
  }
  if (authorizedUser(value)) {
    return "authorized_user";
  }
  if (
    value.type === "impersonated_service_account" &&
    typeof value.service_account_impersonation_url === "string" &&
    value.service_account_impersonation_url.startsWith("https://") &&
    authorizedUser(value.source_credentials)
  ) {
    return "impersonated_service_account";
  }
  throw refused();
}

/** Liveness proof: one access-token mint whose output is discarded unread. */
export type NativeGcloudMint = () => Promise<void>;
const mintAccessToken: NativeGcloudMint = async () => {
  const token = await runNativePrivateCli({
    executable: "gcloud",
    args: ["auth", "application-default", "print-access-token"],
    environment: { CLOUDSDK_CORE_DISABLE_PROMPTS: "1" },
    refused,
    missing: missingCli,
  });
  token.fill(0);
};

/**
 * Explicit gcloud Application Default Credentials adaptation, file mode.
 *
 * Only services whose authored Compose declares a recognized read-only bind of
 * `~/.config/gcloud/application_default_credentials.json` are selected. Their
 * mount is removed from public Compose and the same bytes are delivered as a
 * private mode-0400 file at the authored target, read-only, for the container's
 * lifetime. That places the ADC refresh token in the VM; it is no wider than the
 * Compose bind mount it replaces and is a startup snapshot: host re-login or
 * revocation is not propagated until restart.
 *
 * With `deliver: false` only recognition and selector checks run (no host read,
 * no gcloud call, no files); exec and other value-free rechecks use this.
 * The receipt names the mode, admitted types and services only.
 */
export async function adaptNativeGcloudEnvironment(opts: {
  readonly input: NativeProjectInput;
  readonly mode: NativeGcloudMode;
  readonly deliver?: boolean;
  readonly homeDirectory?: string;
  readonly mint?: NativeGcloudMint;
}): Promise<{
  readonly input: NativeProjectInput;
  readonly receipt: {
    readonly mode: NativeGcloudMode;
    readonly types: readonly string[];
    readonly services: readonly string[];
  };
}> {
  let bytes: Buffer | undefined;
  try {
    if (opts.mode !== "file") {
      throw refused();
    }
    const home = opts.homeDirectory ?? resolveUserHomeDir();
    const { compose, managed, targets } = prepareServices(opts.input, home);
    const services = [...targets.keys()].sort();
    const output = {
      ...opts.input,
      normalizedComposeJson: JSON.stringify(compose),
      managedEnvironment: managed,
    };
    if (opts.deliver === false) {
      return { input: output, receipt: { mode: "file", types: [], services } };
    }
    const path = join(home, ADC_RELATIVE);
    const read = await readAdc(path);
    bytes = read.bytes;
    const type = nativeGcloudCredentialType(bytes);
    await (opts.mint ?? mintAccessToken)();
    if ((await currentIdentity(path)) !== read.identity) {
      throw refused();
    }
    const files: Record<string, readonly NativeManagedFile[]> = {
      ...opts.input.managedFiles,
    };
    for (const [name, target] of targets) {
      files[name] = [
        ...(files[name] ?? []),
        { name: MEMBER, target, content: bytes },
      ];
    }
    return {
      input: { ...output, managedFiles: files },
      receipt: { mode: "file", types: [type], services },
    };
  } catch (error) {
    bytes?.fill(0);
    if (error instanceof MissingGcloudCli) {
      throw error;
    }
    throw refused();
  }
}
