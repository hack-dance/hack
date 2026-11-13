import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";

import { GLOBAL_CADDY_PROJECT_NAME } from "../constants.ts";
import { readTextFile } from "./fs.ts";
import { isRecord } from "./guards.ts";
import { EXEC_STDOUT_OVERFLOW_EXIT, exec } from "./shell.ts";
import { readSingleRegularFileFromTar } from "./single-file-tar.ts";

const MAX_CERTIFICATE_BYTES = 65_536;
/** One certificate entry, an optional PAX header and tar padding. */
const MAX_ARCHIVE_BYTES = MAX_CERTIFICATE_BYTES + 32_768;
const FULL_CONTAINER_ID = /^[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{12,64}$/;
const SINGLE_CERTIFICATE =
  /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/;
const ROOT_PATH = "/data/caddy/pki/authorities/local/root.crt";
const INSPECT_FORMAT =
  '{"id":{{json .Id}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"ports":{{json .NetworkSettings.Ports}}}';
/**
 * Select Hack's Caddy by its Compose labels with the project fixed, never
 * through the user-writable Compose file: a file whose top-level `name:` was
 * changed must not be able to point the witness at another project's `caddy`.
 */
const SELECT_CADDY = [
  "docker",
  "ps",
  "--quiet",
  "--no-trunc",
  "--filter",
  `label=com.docker.compose.project=${GLOBAL_CADDY_PROJECT_NAME}`,
  "--filter",
  "label=com.docker.compose.service=caddy",
] as const;

export type CaddyCaIdentity = {
  readonly state: "current" | "stale" | "missing" | "unavailable" | "invalid";
  readonly message: string;
  /** Present only when a current runtime CA was validated and export comparison succeeded. */
  readonly currentPem?: string;
  /** Loopback addresses covered by the running container's actual 80/443 publications. */
  readonly loopbackPorts?: Readonly<Record<80 | 443, readonly string[]>>;
};

/** Unknown/malformed publication metadata never implies a wildcard bind. */
function publishedLoopbackPorts(
  value: unknown
): CaddyCaIdentity["loopbackPorts"] {
  if (!isRecord(value)) {
    return undefined;
  }
  const ports: Record<80 | 443, string[]> = { 80: [], 443: [] };
  for (const port of [80, 443] as const) {
    const bindings = loopbackBindings(value[`${port}/tcp`], port);
    if (!bindings) {
      return undefined;
    }
    ports[port] = bindings;
  }
  return ports;
}

function loopbackBindings(
  value: unknown,
  port: 80 | 443
): string[] | undefined {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 32) {
    return undefined;
  }
  const addresses = new Set<string>();
  for (const binding of value) {
    if (
      !isRecord(binding) ||
      typeof binding.HostIp !== "string" ||
      typeof binding.HostPort !== "string"
    ) {
      return undefined;
    }
    if (binding.HostPort !== String(port)) {
      continue;
    }
    const address = binding.HostIp;
    if (address !== "" && !isIP(address)) {
      return undefined;
    }
    if (address === "" || address === "0.0.0.0" || address === "::") {
      addresses.add(address || "0.0.0.0");
    } else if (address.startsWith("127.") || address === "::1") {
      addresses.add(address);
    }
  }
  return [...addresses];
}

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
    value.project === GLOBAL_CADDY_PROJECT_NAME &&
    value.service === "caddy"
  );
}

/**
 * Distroless Caddy has no shell tools. Only the public root is copied, and it
 * is streamed (`docker cp … -`) into bounded memory as a tar archive rather
 * than written to a path: a same-user process cannot swap a file between the
 * copy and the read, because there is no file. Docker cp is time-bounded, and
 * output past the archive budget kills the copy.
 */
async function copyRuntimeRoot(opts: {
  readonly id: string;
  readonly execute: typeof exec;
  readonly timeoutMs: number;
}): Promise<{ readonly pem: string } | { readonly invalid: true } | null> {
  const copied = await opts.execute(
    ["docker", "cp", `${opts.id}:${ROOT_PATH}`, "-"],
    {
      timeoutMs: opts.timeoutMs,
      stdin: "ignore",
      maxStdoutBytes: MAX_ARCHIVE_BYTES,
    }
  );
  if (copied.exitCode === EXEC_STDOUT_OVERFLOW_EXIT) {
    return { invalid: true };
  }
  if (copied.exitCode !== 0) {
    return null;
  }
  const content = readSingleRegularFileFromTar({
    archive: Buffer.from(copied.stdout, "latin1"),
    name: "root.crt",
    maxBytes: MAX_CERTIFICATE_BYTES,
  });
  return content === null
    ? { invalid: true }
    : { pem: Buffer.from(content).toString("utf8") };
}

/**
 * Compare the exported root with the exact running Compose Caddy's public CA.
 * This performs no export, trust installation or repair. Names are not identity;
 * equal DER bytes are. Unavailable runtime evidence never confirms an old export.
 */
export async function inspectCaddyCaIdentity(opts: {
  readonly certPath: string;
  readonly exec?: typeof exec;
  readonly readTextFile?: typeof readTextFile;
  readonly now?: number;
  /** Per Docker read; interactive diagnostics can use a shorter allowance. */
  readonly timeoutMs?: number;
}): Promise<CaddyCaIdentity> {
  const execute = opts.exec ?? exec;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const read = opts.readTextFile ?? readTextFile;
  const unavailable: CaddyCaIdentity = {
    state: "unavailable",
    message: "Current running Caddy CA identity could not be verified",
  };
  let runtimePem: string;
  let loopbackPorts: CaddyCaIdentity["loopbackPorts"];
  try {
    const selected = await execute(SELECT_CADDY, {
      timeoutMs,
      stdin: "ignore",
    });
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
      { timeoutMs, stdin: "ignore" }
    );
    const metadata: unknown = JSON.parse(inspected.stdout);
    if (inspected.exitCode !== 0 || !matchesRunningCaddy(metadata, id)) {
      return unavailable;
    }
    loopbackPorts = isRecord(metadata)
      ? publishedLoopbackPorts(metadata.ports)
      : undefined;
    const copied = await copyRuntimeRoot({ id, execute, timeoutMs });
    if (copied === null) {
      return unavailable;
    }
    if ("invalid" in copied) {
      return {
        state: "invalid",
        message:
          "Running Caddy root certificate copy is not a single regular file within the 64 KiB limit",
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
  const witness = { currentPem, ...(loopbackPorts ? { loopbackPorts } : {}) };
  if (exportedPem === null) {
    return {
      state: "missing",
      message: "Caddy CA export is missing; the running Caddy CA was verified",
      ...witness,
    };
  }
  const exported = parseCa(exportedPem);
  if (!exported) {
    return {
      state: "stale",
      message:
        "Exported Caddy CA is invalid and needs refresh from the verified running root",
      ...witness,
    };
  }
  return current.raw.equals(exported.raw)
    ? {
        state: "current",
        message: "Exported Caddy CA matches the running Caddy root certificate",
        ...witness,
      }
    : {
        state: "stale",
        message:
          "Exported Caddy CA differs from the running Caddy root certificate",
        ...witness,
      };
}
