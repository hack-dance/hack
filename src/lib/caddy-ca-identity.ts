import { X509Certificate } from "node:crypto";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTextFile } from "./fs.ts";
import { isRecord } from "./guards.ts";
import { exec } from "./shell.ts";

const MAX_CERTIFICATE_BYTES = 65_536;
const FULL_CONTAINER_ID = /^[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/;
const SINGLE_CERTIFICATE =
  /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/;
const ROOT_PATH = "/data/caddy/pki/authorities/local/root.crt";
const INSPECT_FORMAT =
  '{"id":{{json .Id}},"running":{{json .State.Running}},"service":{{json (index .Config.Labels "com.docker.compose.service")}}}';

export type CaddyCaIdentity = {
  readonly state: "current" | "stale" | "missing" | "unavailable" | "invalid";
  readonly message: string;
  /** Present only when a current runtime CA was validated and export comparison succeeded. */
  readonly currentPem?: string;
};

function parseCa(pem: string): X509Certificate | null {
  if (
    Buffer.byteLength(pem, "utf8") > MAX_CERTIFICATE_BYTES ||
    !SINGLE_CERTIFICATE.test(pem.trim())
  ) {
    return null;
  }
  try {
    const certificate = new X509Certificate(pem);
    return certificate.ca ? certificate : null;
  } catch {
    return null;
  }
}

function matchesRunningCaddy(value: unknown, id: string): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    FULL_CONTAINER_ID.test(value.id) &&
    value.id.startsWith(id) &&
    value.running === true &&
    value.service === "caddy"
  );
}

/** Distroless Caddy has no shell tools. Only the public root is copied.
 * Docker cp is time-bounded but may write more than 64 KiB before validation;
 * lstat bounds the subsequent memory read and rejects copied symlinks.
 */
async function copyRuntimeRoot(opts: {
  readonly id: string;
  readonly execute: typeof exec;
  readonly read: typeof readTextFile;
}): Promise<{ readonly pem: string } | { readonly invalid: true } | null> {
  const directory = await mkdtemp(join(tmpdir(), "hack-caddy-ca-identity-"));
  const destination = join(directory, "root.crt");
  try {
    const copied = await opts.execute(
      ["docker", "cp", `${opts.id}:${ROOT_PATH}`, destination],
      { timeoutMs: 5000, stdin: "ignore" }
    );
    if (copied.exitCode !== 0) {
      return null;
    }
    const metadata = await lstat(destination);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_CERTIFICATE_BYTES
    ) {
      return { invalid: true };
    }
    const pem = await opts.read(destination);
    return pem === null ? null : { pem };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Compare the exported root with the exact running Compose Caddy's public CA.
 * This performs no export, trust installation or repair. Names are not identity;
 * equal DER bytes are. Unavailable runtime evidence never confirms an old export.
 */
export async function inspectCaddyCaIdentity(opts: {
  readonly composeFile: string;
  readonly certPath: string;
  readonly exec?: typeof exec;
  readonly readTextFile?: typeof readTextFile;
  readonly now?: number;
}): Promise<CaddyCaIdentity> {
  const execute = opts.exec ?? exec;
  const read = opts.readTextFile ?? readTextFile;
  const unavailable: CaddyCaIdentity = {
    state: "unavailable",
    message: "Current running Caddy CA identity could not be verified",
  };
  let runtimePem: string;
  try {
    const selected = await execute(
      ["docker", "compose", "-f", opts.composeFile, "ps", "-q", "caddy"],
      { timeoutMs: 5000, stdin: "ignore" }
    );
    const id = selected.stdout.trim();
    if (selected.exitCode !== 0 || !CONTAINER_ID.test(id)) {
      return unavailable;
    }
    const inspected = await execute(
      [
        "docker",
        "inspect",
        "--type",
        "container",
        "--format",
        INSPECT_FORMAT,
        id,
      ],
      { timeoutMs: 5000, stdin: "ignore" }
    );
    if (
      inspected.exitCode !== 0 ||
      !matchesRunningCaddy(JSON.parse(inspected.stdout), id)
    ) {
      return unavailable;
    }
    const copied = await copyRuntimeRoot({ id, execute, read });
    if (copied === null) {
      return unavailable;
    }
    if ("invalid" in copied) {
      return {
        state: "invalid",
        message:
          "Running Caddy root certificate copy is not a regular file within the 64 KiB limit",
      };
    }
    runtimePem = copied.pem;
  } catch {
    return unavailable;
  }
  const current = parseCa(runtimePem);
  const now = opts.now ?? Date.now();
  if (
    !(
      current &&
      Number.isFinite(now) &&
      Number.isFinite(Date.parse(current.validFrom)) &&
      Number.isFinite(Date.parse(current.validTo))
    ) ||
    now < Date.parse(current.validFrom) ||
    now > Date.parse(current.validTo)
  ) {
    return {
      state: "invalid",
      message:
        "Running Caddy root certificate is not a single valid CA at the current time",
    };
  }
  let exportedPem: string | null;
  try {
    exportedPem = await read(opts.certPath);
  } catch {
    return {
      state: "unavailable",
      message: "Exported Caddy CA could not be read for identity comparison",
    };
  }
  const currentPem = current.toString();
  if (exportedPem === null) {
    return {
      state: "missing",
      message: "Caddy CA export is missing; the running Caddy CA was verified",
      currentPem,
    };
  }
  const exported = parseCa(exportedPem);
  if (!exported) {
    return {
      state: "stale",
      message:
        "Exported Caddy CA is invalid and needs refresh from the verified running root",
      currentPem,
    };
  }
  return current.raw.equals(exported.raw)
    ? {
        state: "current",
        message: "Exported Caddy CA matches the running Caddy root certificate",
        currentPem,
      }
    : {
        state: "stale",
        message:
          "Exported Caddy CA differs from the running Caddy root certificate",
        currentPem,
      };
}
