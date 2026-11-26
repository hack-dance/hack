import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  X509Certificate,
} from "node:crypto";
import {
  closeSync,
  constants,
  mkdtempSync,
  openSync,
  rmSync,
  type Stats,
} from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { childEnvironment } from "../lib/child-environment.ts";
import { ClosedCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import { listenPublishedUnixSocket } from "../lib/unix-socket-publish.ts";
import { nativeExecutableDigests } from "./native-executable-hash.ts";
import { checkNativeHttpsPort } from "./native-https-port.ts";
import { NativeHttpsStartupError } from "./native-https-startup-failure.ts";
import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
  readNativeFailureCode,
} from "./native-runtime-client.ts";

const PROBE_PATH_BYTES = /^[\x21-\x7e]+$/;
const HTTP_STATUS = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: [^\r\n]*)?$/;
const SHA = /^[a-f0-9]{64}$/;
const SINGLE_CERTIFICATE =
  /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/;
const OWNER_RECEIPT = "active-owner.json";
/**
 * How long the hostname authority waits for the provider lease at startup
 * (`AUTHORITY_STARTUP_LEASE_WAIT` in the runtime). It starts at a run's ready
 * line, beside that run's first commands and a `hack down` whose graph stop
 * holds the lease for about 12 s (HACK-2707).
 */
export const NATIVE_HTTPS_AUTHORITY_LEASE_WAIT_MS = 30_000;
/** Authority and Caddy readiness after the authority has the lease. */
const NATIVE_HTTPS_READY_MS = 10_000;
/**
 * The whole child startup: the authority's lease wait plus readiness. A
 * client that waits for a starting shared owner waits longer than this.
 */
export const NATIVE_HTTPS_CHILD_STARTUP_MS =
  NATIVE_HTTPS_AUTHORITY_LEASE_WAIT_MS + NATIVE_HTTPS_READY_MS;
const OWNER_SOCKET = "owner.sock";
const BASE64_PUBLIC_KEY = /^[A-Za-z0-9+/=]{1,256}$/;
const HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function isValidPort(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 65_535
  );
}
export interface HttpsChild {
  readonly pid: number;
  readonly exited: Promise<number>;
  /** Only structured native codes; arbitrary child output never leaves the spawn boundary. */
  readonly failure?: Promise<NativeRuntimeRequestError | undefined>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  endInput(): void;
}
interface SpawnInput {
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
  readonly pipe: boolean;
  readonly nativeDiagnostics?: boolean;
}
interface Dependencies {
  readonly checkPort: typeof checkNativeHttpsPort;
  readonly invoke: typeof invokeNativeRuntime;
  readonly spawn: (input: SpawnInput) => HttpsChild;
  readonly permissionPort: () => Promise<number>;
  readonly adminReady: (socket: string) => Promise<boolean>;
  /**
   * Test seam: runs after the owner socket is published and before it is
   * verified. Production does nothing.
   */
  readonly afterOwnerSocketPublish: (path: string) => Promise<void>;
}
const SAFE_TLS_CODES = new Set([
  "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR",
  "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ECONNREFUSED",
  "ECONNRESET",
  "EPROTO",
  "ETIMEDOUT",
]);
/** Return only fixed classifications; raw TLS messages can contain peer values. */
export function nativeHttpsVerificationError(
  error: unknown,
  timedOut = false,
  phase: "handshake" | "response" = "handshake"
): Error {
  let code = "TLS_OR_TRANSPORT_ERROR";
  if (timedOut) {
    code =
      phase === "handshake"
        ? "VERIFICATION_TIMEOUT_HANDSHAKE"
        : "VERIFICATION_TIMEOUT_RESPONSE";
  } else if (
    isRecord(error) &&
    typeof error.code === "string" &&
    SAFE_TLS_CODES.has(error.code)
  ) {
    code = error.code;
  }
  return new ClosedCliError(
    `Native HTTPS verification failed (${code}); peer values omitted.`
  );
}
function refused(): Error {
  return new ClosedCliError(
    "Native HTTPS startup or ownership verification failed; values omitted. Inspect retained owned state before retrying."
  );
}
/** Uses an actual FIFO: Bun's stdin pipe is a socket on some hosts. */
export function spawnNativeHttpsChild(input: SpawnInput): HttpsChild {
  let directory: string | undefined;
  let reader: number | undefined;
  let writer: number | undefined;
  const endInput = () => {
    if (writer !== undefined) {
      closeSync(writer);
      writer = undefined;
    }
  };
  const cleanup = () => {
    endInput();
    if (reader !== undefined) {
      closeSync(reader);
      reader = undefined;
    }
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
      directory = undefined;
    }
  };
  try {
    if (input.pipe) {
      directory = mkdtempSync(join(tmpdir(), "hk-https-pipe-"));
      const fifo = join(directory, "stdin");
      const made = Bun.spawnSync(["/usr/bin/mkfifo", "-m", "600", fifo], {
        env: childEnvironment(),
        stdout: "ignore",
        stderr: "ignore",
        timeout: 5000,
      });
      if (made.exitCode !== 0) {
        throw refused();
      }
      reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    }
    const argv = directory
      ? [
          "/bin/sh",
          "-c",
          'fifo=$1; shift; exec "$@" < "$fifo"',
          "native-https-owner",
          join(directory, "stdin"),
          ...input.argv,
        ]
      : [...input.argv];
    const child = Bun.spawn(argv, {
      env: childEnvironment(input.env),
      stdin: "ignore",
      stdout: "ignore",
      stderr: input.nativeDiagnostics ? "pipe" : "ignore",
    });
    const failure =
      input.nativeDiagnostics && child.stderr
        ? captureNativeHttpsChildFailure({
            exited: child.exited,
            stderr: child.stderr,
          })
        : undefined;
    // Open only after spawn: native children must never inherit the owner writer.
    if (directory) {
      writer = openSync(join(directory, "stdin"), constants.O_WRONLY);
    }
    if (reader !== undefined) {
      closeSync(reader);
      reader = undefined;
    }
    return {
      pid: child.pid,
      exited: child.exited.finally(cleanup),
      ...(failure ? { failure } : {}),
      kill: (signal) => {
        if (child.exitCode === null) {
          child.kill(signal);
        }
      },
      endInput,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
/** Drain only bounded native error codes; inherited stderr cannot extend child-exit classification. */
export async function captureNativeHttpsChildFailure(opts: {
  readonly exited: Promise<number>;
  readonly stderr: ReadableStream<Uint8Array>;
}): Promise<NativeRuntimeRequestError | undefined> {
  const abort = new AbortController();
  const nativeCode = readNativeFailureCode(opts.stderr, abort.signal);
  const code = await opts.exited;
  const timer = setTimeout(() => abort.abort(), 100);
  try {
    const native = await nativeCode;
    return code === 0
      ? undefined
      : new NativeRuntimeRequestError({
          message:
            "Native HTTPS authority exited before readiness; values omitted.",
          nativeCode: native,
        });
  } finally {
    clearTimeout(timer);
  }
}
async function permissionPort(): Promise<number> {
  const server = createServer();
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (!address || typeof address === "string") {
          reject(refused());
        } else {
          resolve(address.port);
        }
      });
    });
  });
}
async function adminReady(socket: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const req = request(
      { socketPath: socket, path: "/config/", timeout: 500 },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
    req.end();
  });
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (!(isRecord(error) && error.code === "EEXIST")) {
      throw error;
    }
  });
  await inspectPrivateDirectory(path);
}
async function inspectPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o777) !== 0o700 ||
    (await realpath(path)) !== path
  ) {
    throw refused();
  }
}
async function boundedFile(
  path: string,
  limit: number,
  privateOwner = false
): Promise<Buffer> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > limit ||
      (privateOwner &&
        (before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600))
    ) {
      throw refused();
    }
    const bytes = Buffer.alloc(before.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    if (
      bytesRead !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw refused();
    }
    return bytes.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
function config(opts: {
  admin: string;
  authority: string;
  httpsPort: number;
  permissionPort: number;
}): string {
  const quoted = (value: string) => JSON.stringify(value);
  return `{
 admin ${quoted(`unix/${opts.admin}|0600`)}
 persist_config off
 skip_install_trust
 auto_https disable_redirects
 grace_period 1s
 on_demand_tls {
  permission http http://127.0.0.1:${opts.permissionPort}/ask
 }
 servers {
  strict_sni_host on
 }
}
http://127.0.0.1:${opts.permissionPort} {
 bind 127.0.0.1
 route {
  @permission path /ask
  reverse_proxy @permission ${quoted(`unix/${opts.authority}`)}
  respond 404
 }
}
https://:${opts.httpsPort} {
 bind 127.0.0.1
 tls internal {
  on_demand
 }
 route {
  vars native_probe {http.request.header.X-Hack-Probe-Request}
  request_header -X-Hack-Probe-Request
  request_header -X-Hack-Endpoint
  forward_auth ${quoted(`unix/${opts.authority}`)} {
   uri /route?
   copy_headers X-Hack-Endpoint
  }
  reverse_proxy unix/{http.request.header.X-Hack-Endpoint} {
   header_up Host {hostport}
   header_up -X-Hack-Endpoint
   header_down X-Hack-Upstream-Proof {http.vars.native_probe}
  }
 }
}
`;
}
async function removeOwnedDirectory(
  path: string,
  identity: { dev: number; ino: number } | undefined,
  recursive: boolean
): Promise<void> {
  const observed = await lstat(path);
  if (
    !(identity && observed.isDirectory()) ||
    observed.dev !== identity.dev ||
    observed.ino !== identity.ino
  ) {
    throw refused();
  }
  if (recursive) {
    await rm(path, { recursive: true });
  } else {
    await rmdir(path);
  }
}
async function settle(
  child: HttpsChild,
  milliseconds: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
async function stop(child: HttpsChild, pipe: boolean): Promise<void> {
  if (pipe) {
    child.endInput();
  } else {
    child.kill("SIGTERM");
  }
  if (await settle(child, 3000)) {
    return;
  }
  child.kill("SIGKILL");
  if (!(await settle(child, 2000))) {
    throw refused();
  }
}
async function stopAuthority(opts: {
  child: HttpsChild;
  owned?: { socket: string; sha256: string };
  invoke: typeof invokeNativeRuntime;
  runtime: NativeRuntimeSelection;
  home: string;
}): Promise<void> {
  // Darwin poll does not reliably report EOF for named FIFOs. Use the runtime's
  // cooperative identity-checked stop, retaining EOF and bounded kill as fallback.
  if (opts.owned) {
    try {
      await opts.invoke({
        runtime: opts.runtime,
        cwd: opts.home,
        args: [
          "runtime",
          "stop-hostname-authority",
          "--socket",
          opts.owned.socket,
          "--expect-sha256",
          opts.owned.sha256,
          "--json",
        ],
        timeoutMs: 5000,
      });
    } catch {
      /* Absence is verified separately; never infer cleanup from exit alone. */
    }
  }
  await stop(opts.child, true);
}
async function retireAuthority(opts: {
  inspect: () => Promise<unknown>;
  invoke: typeof invokeNativeRuntime;
  runtime: NativeRuntimeSelection;
  home: string;
  owned?: { socket: string; sha256: string };
}): Promise<void> {
  const value = await opts.inspect();
  if (!(isRecord(value) && isRecord(value.authority))) {
    throw refused();
  }
  if (value.authority.present === false) {
    return;
  }
  if (
    !opts.owned ||
    value.socket !== opts.owned.socket ||
    value.authority.sha256 !== opts.owned.sha256 ||
    value.authority.process_present !== false
  ) {
    throw refused();
  }
  await opts.invoke({
    runtime: opts.runtime,
    cwd: opts.home,
    args: [
      "runtime",
      "recover-hostname-authority",
      "--socket",
      opts.owned.socket,
      "--expect-sha256",
      opts.owned.sha256,
      "--json",
    ],
    timeoutMs: 5000,
  });
  const after = await opts.inspect();
  if (
    !(isRecord(after) && isRecord(after.authority)) ||
    after.authority.present !== false
  ) {
    throw refused();
  }
}
async function authorityIdentity(
  value: unknown,
  pid: number
): Promise<{ socket: string; sha256: string }> {
  if (
    !(
      isRecord(value) &&
      typeof value.socket === "string" &&
      isAbsolute(value.socket) &&
      isRecord(value.authority) &&
      value.authority.present === true &&
      value.authority.process_present === true &&
      value.authority.socket_present === true &&
      typeof value.authority.sha256 === "string" &&
      SHA.test(value.authority.sha256)
    )
  ) {
    throw refused();
  }
  const bytes = await boundedFile(`${value.socket}.identity`, 4096);
  const record: unknown = JSON.parse(bytes.toString("utf8"));
  const socket = await lstat(value.socket);
  if (
    createHash("sha256").update(bytes).digest("hex") !==
      value.authority.sha256 ||
    !(
      isRecord(record) &&
      isRecord(record.process) &&
      record.process.pid === pid
    ) ||
    !socket.isSocket() ||
    socket.uid !== process.getuid?.()
  ) {
    throw refused();
  }
  return { socket: value.socket, sha256: value.authority.sha256 };
}
async function validCa(path: string): Promise<Buffer> {
  const pem = await boundedFile(path, 65_536);
  if (!SINGLE_CERTIFICATE.test(pem.toString("utf8").trim())) {
    throw refused();
  }
  const cert = new X509Certificate(pem);
  if (
    !cert.ca ||
    Date.now() < Date.parse(cert.validFrom) ||
    Date.now() > Date.parse(cert.validTo)
  ) {
    throw refused();
  }
  return pem;
}

export interface NativeListenerIdentity {
  readonly pid: number;
  readonly start_micros: number;
  readonly uid: number;
  readonly executable: string;
  readonly port: number;
  readonly fingerprint: string;
}
interface NativeHttpsOwnerReceipt {
  readonly version: 1;
  readonly listener: NativeListenerIdentity;
  readonly caddySha256: string;
  readonly caSha256: string;
  readonly authority: {
    readonly pid: number;
    readonly socket: string;
    readonly sha256: string;
  };
  readonly lock: { readonly dev: number; readonly ino: number };
  readonly owner: {
    readonly publicKey: string;
    readonly dev: number;
    readonly ino: number;
  };
}
function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function parseListenerIdentity(value: unknown): NativeListenerIdentity {
  if (
    !(
      isRecord(value) &&
      exactKeys(value, [
        "pid",
        "start_micros",
        "uid",
        "executable",
        "port",
        "fingerprint",
      ]) &&
      Number.isSafeInteger(value.pid) &&
      Number(value.pid) > 0 &&
      Number.isSafeInteger(value.start_micros) &&
      Number(value.start_micros) > 0 &&
      Number.isSafeInteger(value.uid) &&
      Number(value.uid) >= 0 &&
      typeof value.executable === "string" &&
      isAbsolute(value.executable) &&
      Number.isSafeInteger(value.port) &&
      Number(value.port) > 0 &&
      Number(value.port) <= 65_535 &&
      typeof value.fingerprint === "string" &&
      SHA.test(value.fingerprint)
    )
  ) {
    throw refused();
  }
  return {
    pid: Number(value.pid),
    start_micros: Number(value.start_micros),
    uid: Number(value.uid),
    executable: value.executable,
    port: Number(value.port),
    fingerprint: value.fingerprint,
  };
}
function sameListenerIdentity(
  left: NativeListenerIdentity,
  right: NativeListenerIdentity
): boolean {
  return (
    left.pid === right.pid &&
    left.start_micros === right.start_micros &&
    left.uid === right.uid &&
    left.executable === right.executable &&
    left.port === right.port &&
    left.fingerprint === right.fingerprint
  );
}
function parseOwnerReceipt(value: unknown): NativeHttpsOwnerReceipt {
  if (
    !(
      isRecord(value) &&
      exactKeys(value, [
        "version",
        "listener",
        "caddySha256",
        "caSha256",
        "authority",
        "lock",
        "owner",
      ]) &&
      value.version === 1 &&
      typeof value.caddySha256 === "string" &&
      SHA.test(value.caddySha256) &&
      typeof value.caSha256 === "string" &&
      SHA.test(value.caSha256) &&
      isRecord(value.authority) &&
      exactKeys(value.authority, ["pid", "socket", "sha256"]) &&
      Number.isSafeInteger(value.authority.pid) &&
      Number(value.authority.pid) > 0 &&
      typeof value.authority.socket === "string" &&
      isAbsolute(value.authority.socket) &&
      typeof value.authority.sha256 === "string" &&
      SHA.test(value.authority.sha256) &&
      isRecord(value.lock) &&
      exactKeys(value.lock, ["dev", "ino"]) &&
      Number.isSafeInteger(value.lock.dev) &&
      Number.isSafeInteger(value.lock.ino) &&
      isRecord(value.owner) &&
      exactKeys(value.owner, ["publicKey", "dev", "ino"]) &&
      typeof value.owner.publicKey === "string" &&
      BASE64_PUBLIC_KEY.test(value.owner.publicKey) &&
      Number.isSafeInteger(value.owner.dev) &&
      Number.isSafeInteger(value.owner.ino)
    )
  ) {
    throw refused();
  }
  return {
    version: 1,
    listener: parseListenerIdentity(value.listener),
    caddySha256: value.caddySha256,
    caSha256: value.caSha256,
    authority: {
      pid: Number(value.authority.pid),
      socket: value.authority.socket,
      sha256: value.authority.sha256,
    },
    lock: { dev: Number(value.lock.dev), ino: Number(value.lock.ino) },
    owner: {
      publicKey: value.owner.publicKey,
      dev: Number(value.owner.dev),
      ino: Number(value.owner.ino),
    },
  };
}
async function inspectHostListener(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly invoke: typeof invokeNativeRuntime;
  readonly pid: number;
  readonly port: number;
  readonly executable: string;
}): Promise<NativeListenerIdentity> {
  const value = await opts.invoke({
    runtime: opts.runtime,
    cwd: opts.runtime.home,
    args: [
      "runtime",
      "inspect-host-listener",
      "--pid",
      String(opts.pid),
      "--port",
      String(opts.port),
      "--executable",
      opts.executable,
      "--json",
    ],
    timeoutMs: 5000,
  });
  const identity = parseListenerIdentity(value);
  if (
    identity.pid !== opts.pid ||
    identity.port !== opts.port ||
    identity.executable !== opts.executable ||
    identity.uid !== process.getuid?.()
  ) {
    throw refused();
  }
  return identity;
}
function caDerSha256(pem: Buffer): string {
  return createHash("sha256")
    .update(new X509Certificate(pem).raw)
    .digest("hex");
}
async function startOwnerChallenge(
  path: string,
  afterPublish: (path: string) => Promise<void>
): Promise<{
  readonly server: Server;
  readonly publicKey: string;
  readonly identity: { readonly dev: number; readonly ino: number };
}> {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  const server = createServer((socket) => {
    let challenge = Buffer.alloc(0);
    let answered = false;
    socket.setTimeout(1000, () => socket.destroy());
    socket.on("data", (chunk: Buffer) => {
      if (answered || challenge.length + chunk.length > 32) {
        socket.destroy();
        return;
      }
      challenge = Buffer.concat([challenge, chunk]);
      if (challenge.length === 32) {
        answered = true;
        socket.end(sign(null, challenge, keys.privateKey));
      }
    });
  });
  let identity: { dev: number; ino: number } | undefined;
  try {
    // Created with mode 0600 and published by link from a staging name: closing
    // the server never removes a replacement at path, and path is never chmodded.
    identity = await listenPublishedUnixSocket(server, path);
    await afterPublish(path);
    const prepared = await lstat(path);
    if (
      !prepared.isSocket() ||
      prepared.dev !== identity.dev ||
      prepared.ino !== identity.ino ||
      prepared.uid !== process.getuid?.() ||
      (prepared.mode & 0o777) !== 0o600
    ) {
      throw refused();
    }
    return { server, publicKey, identity };
  } catch {
    // Without an identity, publication failed and already closed the server.
    if (identity) {
      await stopOwnerChallenge({ path, server, identity });
    }
    throw refused();
  }
}
async function stopOwnerChallenge(opts: {
  readonly path: string;
  readonly server: Server;
  readonly identity: { readonly dev: number; readonly ino: number };
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    opts.server.close((error) => (error ? reject(error) : resolve()));
  });
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(opts.path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return;
    }
    throw refused();
  }
  if (
    !metadata.isSocket() ||
    metadata.dev !== opts.identity.dev ||
    metadata.ino !== opts.identity.ino
  ) {
    throw refused();
  }
  await unlink(opts.path);
}
async function challengeOwner(opts: {
  readonly path: string;
  readonly publicKey: string;
}): Promise<void> {
  const keyBytes = Buffer.from(opts.publicKey, "base64");
  const key = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !key.export({ format: "der", type: "spki" }).equals(keyBytes)
  ) {
    throw refused();
  }
  const challenge = randomBytes(32);
  const signature = await new Promise<Buffer>((resolve, reject) => {
    const socket = connect(opts.path);
    let response = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error || response.length !== 64) {
        reject(refused());
      } else {
        resolve(response);
      }
    };
    socket.setTimeout(1000, () => finish(refused()));
    socket.once("connect", () => socket.write(challenge));
    socket.on("data", (chunk: Buffer) => {
      if (response.length + chunk.length > 64) {
        finish(refused());
        return;
      }
      response = Buffer.concat([response, chunk]);
    });
    socket.once("end", () => finish());
    socket.once("error", () => finish(refused()));
    socket.once("close", () => finish(refused()));
  });
  if (!verify(null, challenge, key, signature)) {
    throw refused();
  }
}
async function publishOwnerReceipt(opts: {
  readonly path: string;
  readonly receipt: NativeHttpsOwnerReceipt;
}): Promise<{ dev: number; ino: number; sha256: string }> {
  const temporary = `${opts.path}.${crypto.randomUUID()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify(opts.receipt)}\n`);
  try {
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600
    );
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    // A hard link publishes atomically and refuses to replace a stale receipt.
    await link(temporary, opts.path);
  } finally {
    await rm(temporary, { force: true });
  }
  const metadata = await lstat(opts.path);
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
async function retireOwnerReceipt(opts: {
  readonly path: string;
  readonly identity: {
    readonly dev: number;
    readonly ino: number;
    readonly sha256: string;
  };
}): Promise<void> {
  const metadata = await lstat(opts.path);
  const bytes = await boundedFile(opts.path, 4096, true);
  if (
    metadata.dev !== opts.identity.dev ||
    metadata.ino !== opts.identity.ino ||
    createHash("sha256").update(bytes).digest("hex") !== opts.identity.sha256
  ) {
    throw refused();
  }
  const current = await lstat(opts.path);
  if (current.dev !== opts.identity.dev || current.ino !== opts.identity.ino) {
    throw refused();
  }
  await unlink(opts.path);
}

/** Verify the exact active native HTTPS owner using private receipt, live Rust listener identity, authority, executable bytes and CA DER. */
export async function inspectActiveNativeHttpsOwner(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<ActiveNativeHttpsOwner> {
  try {
    const home = await realpath(opts.runtime.home);
    if (home !== opts.runtime.home) {
      throw refused();
    }
    const storage = join(home, "native-https");
    const data = join(storage, "data");
    const lock = join(storage, "owner.lock");
    const receiptPath = join(storage, OWNER_RECEIPT);
    const ownerSocket = join(storage, OWNER_SOCKET);
    for (const path of [home, storage, data, lock]) {
      await inspectPrivateDirectory(path);
    }
    const bytes = await boundedFile(receiptPath, 4096, true);
    const receipt = parseOwnerReceipt(
      JSON.parse(bytes.toString("utf8")) as unknown
    );
    const lockMetadata = await lstat(lock);
    if (
      lockMetadata.dev !== receipt.lock.dev ||
      lockMetadata.ino !== receipt.lock.ino
    ) {
      throw refused();
    }
    const ownerMetadata = await lstat(ownerSocket);
    if (
      !ownerMetadata.isSocket() ||
      ownerMetadata.uid !== process.getuid?.() ||
      (ownerMetadata.mode & 0o777) !== 0o600 ||
      ownerMetadata.dev !== receipt.owner.dev ||
      ownerMetadata.ino !== receipt.owner.ino
    ) {
      throw refused();
    }
    await challengeOwner({
      path: ownerSocket,
      publicKey: receipt.owner.publicKey,
    });
    if (
      (await nativeExecutableDigests.sha256(receipt.listener.executable, {
        refused,
        singleLink: true,
      })) !== receipt.caddySha256
    ) {
      throw refused();
    }
    const live = await inspectHostListener({
      runtime: opts.runtime,
      invoke: opts.invoke ?? invokeNativeRuntime,
      pid: receipt.listener.pid,
      port: receipt.listener.port,
      executable: receipt.listener.executable,
    });
    if (!sameListenerIdentity(live, receipt.listener)) {
      throw refused();
    }
    const authority = await (opts.invoke ?? invokeNativeRuntime)({
      runtime: opts.runtime,
      cwd: home,
      args: ["runtime", "managed-hostname-authority", "--json"],
      timeoutMs: 5000,
    });
    const ownedAuthority = await authorityIdentity(
      authority,
      receipt.authority.pid
    );
    if (
      ownedAuthority.socket !== receipt.authority.socket ||
      ownedAuthority.sha256 !== receipt.authority.sha256
    ) {
      throw refused();
    }
    const caPath = join(data, "caddy/pki/authorities/local/root.crt");
    if (caDerSha256(await validCa(caPath)) !== receipt.caSha256) {
      throw refused();
    }
    const after = await boundedFile(receiptPath, 4096, true);
    const afterLock = await lstat(lock);
    const afterOwner = await lstat(ownerSocket);
    if (
      !after.equals(bytes) ||
      afterLock.dev !== receipt.lock.dev ||
      afterLock.ino !== receipt.lock.ino ||
      afterOwner.dev !== receipt.owner.dev ||
      afterOwner.ino !== receipt.owner.ino
    ) {
      throw refused();
    }
    return {
      caPath,
      caSha256: receipt.caSha256,
      httpsPort: receipt.listener.port,
      listenerFingerprint: receipt.listener.fingerprint,
      caddyPid: receipt.listener.pid,
      caddyBinary: receipt.listener.executable,
      listenerIdentity: Object.freeze({ ...receipt.listener }),
    };
  } catch {
    throw refused();
  }
}

/**
 * How long the authority and Caddy of an owner that exited get to exit on their
 * own. The authority notices within about 2 s (it checks its owner pipe every
 * second) and stops its Caddy as it exits (HACK-2720).
 */
export const NATIVE_HTTPS_EXITED_CHILD_WAIT_MS = 5000;
/**
 * The whole children step's bound, runtime calls included: with the owner
 * admission lock it holds, an exited-owner retirement stays within about 30 s
 * (`retireExitedNativeHttpsOwner`).
 */
export const NATIVE_HTTPS_EXITED_CHILD_BUDGET_MS = 15_000;

/** A runtime call's timeout inside the budget: its own bound or what is left. */
function withinBudget(budgetEnd: number, nominalMs: number): number {
  const left = budgetEnd - Date.now();
  if (left <= 0) {
    throw refused();
  }
  return Math.max(1, Math.min(nominalMs, left));
}

/** What an exited owner's retirement has done so far, for its refusals. */
interface ExitedChildProgress {
  authorityStopped: boolean;
  /** Records already removed, in order. */
  readonly removed: string[];
}

/** A refusal of the exited-owner retirement that names a next step. */
class ExitedChildRefusal extends ClosedCliError {}

/**
 * A refusal that says what was stopped and what to do next (#1271 review).
 * `process`: a child still runs, which may exit by itself or need the user.
 * `records`: retained records did not match; they are evidence, not clutter.
 */
function exitedChildRefused(
  detail: string,
  progress: ExitedChildProgress,
  kind: "process" | "records" = "process"
): Error {
  const stopped = progress.authorityStopped
    ? "The exited owner's hostname authority was stopped through its cooperative stop; nothing else was stopped"
    : "Nothing was stopped";
  const records =
    progress.removed.length === 0
      ? "the retained records were kept"
      : `${progress.removed.join(" and ")} ${progress.removed.length === 1 ? "was" : "were"} already removed and the other retained records were kept`;
  const done = `${stopped}, and ${records}.`;
  const next =
    kind === "process"
      ? "Run hack down again in a few seconds; if this repeats, stop that process yourself, then run hack down again."
      : "Run hack down again; if this repeats, inspect the native-https directory under the runtime home and keep its records (do not delete them to force a start).";
  return new ExitedChildRefusal(`${detail} ${done} ${next}`);
}

/** Run one retirement step; any failure that is not already a refusal with a
 * next step becomes one, described by `detail`. */
async function exitedStep<T>(
  detail: string,
  progress: ExitedChildProgress,
  kind: "process" | "records",
  step: () => Promise<T>
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof ExitedChildRefusal) {
      throw error;
    }
    throw exitedChildRefused(detail, progress, kind);
  }
}

/** Whether a Unix socket refuses connections: no process listens on it. */
async function socketRefuses(path: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = connect(path);
    const finish = (refuses: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(refuses);
    };
    // An answer proves a live listener; silence proves nothing.
    const timer = setTimeout(() => finish(false), 1000);
    socket.once("connect", () => finish(false));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish(error.code === "ECONNREFUSED")
    );
  });
}

/** The file's identity if it exists; anything but ENOENT refuses. */
async function presentEntry(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return;
    }
    throw refused();
  }
}

type ReceiptIdentity = {
  readonly dev: number;
  readonly ino: number;
  readonly sha256: string;
};
interface ExitedOwnerEntries {
  readonly receipt?: {
    readonly value: NativeHttpsOwnerReceipt;
    readonly identity: ReceiptIdentity;
  };
  readonly lock?: Stats;
  readonly owner?: Stats;
}

/** The exited owner's receipt, lock and challenge socket, proven not live. */
async function exitedOwnerEntries(opts: {
  readonly storage: string;
  readonly httpsPort: number;
  readonly progress: ExitedChildProgress;
}): Promise<ExitedOwnerEntries> {
  const receiptPath = join(opts.storage, OWNER_RECEIPT);
  const lockPath = join(opts.storage, "owner.lock");
  const ownerSocket = join(opts.storage, OWNER_SOCKET);
  let receipt: ExitedOwnerEntries["receipt"];
  const receiptEntry = await presentEntry(receiptPath);
  if (receiptEntry) {
    const bytes = await exitedStep(
      "The exited shared HTTPS owner's receipt (active-owner.json) is unreadable or malformed.",
      opts.progress,
      "records",
      () => boundedFile(receiptPath, 4096, true)
    );
    const value = await exitedStep(
      "The exited shared HTTPS owner's receipt (active-owner.json) is unreadable or malformed.",
      opts.progress,
      "records",
      async () =>
        parseOwnerReceipt(JSON.parse(bytes.toString("utf8")) as unknown)
    );
    if (value.listener.port !== opts.httpsPort) {
      throw exitedChildRefused(
        `The exited shared HTTPS owner's receipt names HTTPS port ${value.listener.port}, not ${opts.httpsPort}.`,
        opts.progress,
        "records"
      );
    }
    receipt = {
      value,
      identity: {
        dev: receiptEntry.dev,
        ino: receiptEntry.ino,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    };
  }
  const lock = await presentEntry(lockPath);
  if (lock) {
    const recorded = receipt?.value.lock;
    const exact = await exitedStep(
      "The shared HTTPS owner lock (owner.lock) is not a private directory.",
      opts.progress,
      "records",
      async () => {
        await inspectPrivateDirectory(lockPath);
        return (
          !(
            recorded &&
            (lock.dev !== recorded.dev || lock.ino !== recorded.ino)
          ) && (await readdir(lockPath)).length === 0
        );
      }
    );
    if (!exact) {
      throw exitedChildRefused(
        "The shared HTTPS owner lock (owner.lock) is not empty or is not the one the exited owner's receipt names.",
        opts.progress,
        "records"
      );
    }
  }
  const owner = await presentEntry(ownerSocket);
  const challenge = receipt?.value.owner;
  if (
    owner &&
    (!owner.isSocket() ||
      owner.uid !== process.getuid?.() ||
      (owner.mode & 0o777) !== 0o600 ||
      (challenge &&
        (owner.dev !== challenge.dev || owner.ino !== challenge.ino)))
  ) {
    throw exitedChildRefused(
      "The shared HTTPS owner's challenge socket (owner.sock) is not the one the exited owner's receipt names.",
      opts.progress,
      "records"
    );
  }
  if (owner && !(await socketRefuses(ownerSocket))) {
    throw exitedChildRefused(
      "The shared HTTPS owner's challenge socket (owner.sock) still answers, so its owner may still run.",
      opts.progress
    );
  }
  return { receipt, lock, owner };
}

type AuthorityState =
  | { readonly present: false }
  | {
      readonly present: true;
      readonly alive: boolean;
      readonly owned: { readonly socket: string; readonly sha256: string };
    };

/** The authority as `managed-hostname-authority` reports it, validated. */
function authorityState(value: unknown): AuthorityState {
  if (
    !(
      isRecord(value) &&
      typeof value.socket === "string" &&
      isRecord(value.authority)
    )
  ) {
    throw refused();
  }
  if (value.authority.present === false) {
    return { present: false };
  }
  if (
    value.authority.present !== true ||
    typeof value.authority.sha256 !== "string" ||
    !SHA.test(value.authority.sha256) ||
    typeof value.authority.process_present !== "boolean"
  ) {
    throw refused();
  }
  return {
    present: true,
    alive: value.authority.process_present,
    owned: { socket: value.socket, sha256: value.authority.sha256 },
  };
}

/**
 * Wait for the exited owner's authority to exit on its own; recover a dead
 * one's records; stop one still serving at the deadline only cooperatively and
 * only when the receipt names it exactly; otherwise refuse with a next step.
 */
async function retireExitedAuthority(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly home: string;
  readonly invoke: typeof invokeNativeRuntime;
  readonly receipt: NativeHttpsOwnerReceipt | undefined;
  readonly deadline: number;
  readonly budgetEnd: number;
  readonly progress: ExitedChildProgress;
}): Promise<void> {
  const inspect = async () =>
    opts.invoke({
      runtime: opts.runtime,
      cwd: opts.home,
      args: ["runtime", "managed-hostname-authority", "--json"],
      timeoutMs: withinBudget(opts.budgetEnd, 5000),
    });
  let value = await inspect();
  let state = authorityState(value);
  while (state.present && state.alive && Date.now() < opts.deadline) {
    await Bun.sleep(100);
    value = await inspect();
    state = authorityState(value);
  }
  if (!state.present) {
    return;
  }
  if (!state.alive) {
    // A dead authority's records; the runtime proves its exit by identity.
    const owned = state.owned;
    await exitedStep(
      "The exited hostname authority's records could not be recovered.",
      opts.progress,
      "records",
      () =>
        retireAuthority({
          inspect,
          invoke: opts.invoke,
          runtime: opts.runtime,
          home: opts.home,
          owned,
        })
    );
    return;
  }
  const named = opts.receipt?.authority;
  if (
    !named ||
    named.socket !== state.owned.socket ||
    named.sha256 !== state.owned.sha256
  ) {
    throw exitedChildRefused(
      "The managed hostname authority still runs and the exited shared HTTPS owner's receipt does not name it.",
      opts.progress
    );
  }
  const owned = state.owned;
  await exitedStep(
    "The managed hostname authority still runs and its receipt does not match the exited shared HTTPS owner's.",
    opts.progress,
    "process",
    () => authorityIdentity(value, named.pid)
  );
  await exitedStep(
    "The managed hostname authority's cooperative stop did not confirm its exit (it may have timed out).",
    opts.progress,
    "process",
    async () => {
      await opts.invoke({
        runtime: opts.runtime,
        cwd: opts.home,
        args: [
          "runtime",
          "stop-hostname-authority",
          "--socket",
          owned.socket,
          "--expect-sha256",
          owned.sha256,
          "--json",
        ],
        timeoutMs: withinBudget(opts.budgetEnd, 10_000),
      });
      if (authorityState(await inspect()).present) {
        throw refused();
      }
    }
  );
  opts.progress.authorityStopped = true;
}

/** Caddy leaves the HTTPS port once its authority has stopped it. */
async function awaitExitedCaddy(opts: {
  readonly port: number;
  readonly checkPort: (port: number) => Promise<void>;
  readonly receipt: NativeHttpsOwnerReceipt | undefined;
  readonly deadline: number;
  readonly progress: ExitedChildProgress;
}): Promise<void> {
  for (;;) {
    try {
      await opts.checkPort(opts.port);
      return;
    } catch {
      if (Date.now() >= opts.deadline) {
        throw exitedChildRefused(
          opts.receipt
            ? `HTTPS port ${opts.port} is still in use; the exited shared HTTPS owner's Caddy (process ${opts.receipt.listener.pid}) may still run.`
            : `HTTPS port ${opts.port} is still in use after the shared HTTPS owner exited.`,
          opts.progress
        );
      }
      await Bun.sleep(100);
    }
  }
}

/**
 * Retire what a shared owner that exited without its own cleanup (killed,
 * HACK-2720) left of its child pair, or refuse with a next step. The caller has
 * proved the owner process itself is gone, under the owner admission lock.
 *
 * Nothing here signals a process:
 * - The receipt's owner must be gone: its exact challenge socket refuses
 *   connections. A live one is never touched.
 * - The hostname authority exits by itself once its owner pipe closes, and stops
 *   its Caddy as it goes; it gets {@link NATIVE_HTTPS_EXITED_CHILD_WAIT_MS}. An
 *   authority still serving after that (an older runtime, or one slower than
 *   this caller) is stopped only through the runtime's cooperative,
 *   identity-checked stop, and only when the exited owner's receipt names its
 *   exact socket, receipt hash and process. Otherwise it is refused with a next
 *   step. A dead authority's records are recovered by their exact hash.
 * - Caddy must have left the HTTPS port within the same wait. One that still
 *   holds it is refused with a next step, never stopped from here.
 *
 * Only then are the receipt, the dead challenge socket and the empty owner lock
 * removed, each by its exact identity, so the next owner can start. The
 * temporary session directory (Caddyfile and caches) is left to the system.
 */
export async function retireExitedNativeHttpsChildren(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly httpsPort: number;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly checkPort?: (port: number) => Promise<void>;
  readonly exitWaitMs?: number;
  /** Bound of this whole step; {@link NATIVE_HTTPS_EXITED_CHILD_BUDGET_MS}. */
  readonly budgetMs?: number;
  /**
   * Runs after the children are proven gone and before anything is removed;
   * the caller rechecks the owner process here (#1271 review). A throw keeps
   * every record.
   */
  readonly beforeRemoval?: () => Promise<void>;
}): Promise<void> {
  const deadline =
    Date.now() + (opts.exitWaitMs ?? NATIVE_HTTPS_EXITED_CHILD_WAIT_MS);
  const budgetEnd =
    Date.now() + (opts.budgetMs ?? NATIVE_HTTPS_EXITED_CHILD_BUDGET_MS);
  const progress: ExitedChildProgress = {
    authorityStopped: false,
    removed: [],
  };
  const storage = await exitedStep(
    "The runtime home or its native-https directory is not private.",
    progress,
    "records",
    async () => {
      const home = await realpath(opts.runtime.home);
      if (home !== opts.runtime.home) {
        throw refused();
      }
      await inspectPrivateDirectory(home);
      await inspectPrivateDirectory(join(home, "native-https"));
      return join(home, "native-https");
    }
  );
  const { receipt, lock, owner } = await exitedStep(
    "The exited shared HTTPS owner's receipt, lock or challenge socket could not be read.",
    progress,
    "records",
    () => exitedOwnerEntries({ storage, httpsPort: opts.httpsPort, progress })
  );
  await exitedStep(
    "The managed hostname authority could not be inspected.",
    progress,
    "process",
    () =>
      retireExitedAuthority({
        runtime: opts.runtime,
        home: opts.runtime.home,
        invoke: opts.invoke ?? invokeNativeRuntime,
        receipt: receipt?.value,
        deadline,
        budgetEnd,
        progress,
      })
  );
  await awaitExitedCaddy({
    port: opts.httpsPort,
    checkPort: opts.checkPort ?? checkNativeHttpsPort,
    receipt: receipt?.value,
    deadline,
    progress,
  });
  await opts.beforeRemoval?.();
  await exitedStep(
    "The exited shared HTTPS owner's receipt, challenge socket or lock changed while it was retired.",
    progress,
    "records",
    async () => {
      if (receipt) {
        await retireOwnerReceipt({
          path: join(storage, OWNER_RECEIPT),
          identity: receipt.identity,
        });
        progress.removed.push("the receipt (active-owner.json)");
      }
      if (owner) {
        const ownerSocket = join(storage, OWNER_SOCKET);
        const current = await lstat(ownerSocket);
        // The type and owner too: a replacement can reuse the freed inode
        // number (ext4 does at once), so device and inode alone cannot tell.
        if (
          !current.isSocket() ||
          current.uid !== owner.uid ||
          current.dev !== owner.dev ||
          current.ino !== owner.ino
        ) {
          throw refused();
        }
        await unlink(ownerSocket);
        progress.removed.push("the challenge socket (owner.sock)");
      }
      if (lock) {
        await removeOwnedDirectory(
          join(storage, "owner.lock"),
          { dev: lock.dev, ino: lock.ino },
          false
        );
        progress.removed.push("the owner lock (owner.lock)");
      }
    }
  );
}

export interface ActiveNativeHttpsOwner {
  readonly caPath: string;
  readonly caSha256: string;
  readonly httpsPort: number;
  readonly listenerFingerprint: string;
  readonly caddyPid: number;
  readonly caddyBinary: string;
  readonly listenerIdentity: NativeListenerIdentity;
}

/** Prove that the current TLS socket was accepted by the exact receipted Caddy listener. */
export async function verifyActiveNativeHttpsConnection(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly owner: ActiveNativeHttpsOwner;
  readonly peerPort: number;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<void> {
  try {
    if (!isValidPort(opts.peerPort)) {
      throw refused();
    }
    const current = await inspectActiveNativeHttpsOwner({
      runtime: opts.runtime,
      invoke: opts.invoke,
    });
    if (
      current.caPath !== opts.owner.caPath ||
      current.caSha256 !== opts.owner.caSha256 ||
      !sameListenerIdentity(
        current.listenerIdentity,
        opts.owner.listenerIdentity
      )
    ) {
      throw refused();
    }
    const value = await (opts.invoke ?? invokeNativeRuntime)({
      runtime: opts.runtime,
      cwd: opts.runtime.home,
      args: [
        "runtime",
        "inspect-host-listener",
        "--pid",
        String(current.listenerIdentity.pid),
        "--port",
        String(current.listenerIdentity.port),
        "--executable",
        current.listenerIdentity.executable,
        "--peer-port",
        String(opts.peerPort),
        "--json",
      ],
      timeoutMs: 5000,
    });
    if (
      !(
        isRecord(value) &&
        exactKeys(value, [
          "pid",
          "start_micros",
          "uid",
          "executable",
          "port",
          "fingerprint",
          "accepted",
        ]) &&
        value.accepted === true
      )
    ) {
      throw refused();
    }
    const peer = parseListenerIdentity({
      pid: value.pid,
      start_micros: value.start_micros,
      uid: value.uid,
      executable: value.executable,
      port: value.port,
      fingerprint: value.fingerprint,
    });
    if (!sameListenerIdentity(peer, current.listenerIdentity)) {
      throw refused();
    }
  } catch {
    throw refused();
  }
}
/** Pin TCP to loopback independently of SNI and the HTTP Host authority.
 * Bun's HTTPS adapter refused this distinct transport/SNI selection in a real TLS control.
 */
export function isNativeHttpsProbePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.startsWith("/") &&
    path.length <= 512 &&
    PROBE_PATH_BYTES.test(path) &&
    !path.includes("#")
  );
}
export interface NativeHttpsResponse {
  readonly statusCode: number;
  readonly location?: string;
  /** A fresh request challenge was added by the upstream proxy response handler. */
  readonly upstreamVerified?: true;
}
async function confirmTlsPeer(opts: {
  readonly verifyPeer?: (peerPort: number) => Promise<void>;
  readonly peerPort: number | undefined;
}): Promise<void> {
  if (!opts.verifyPeer) {
    return;
  }
  if (!isValidPort(opts.peerPort)) {
    throw refused();
  }
  await opts.verifyPeer(opts.peerPort);
}
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEADER_VALUE = /^[\x20-\x7e\t]*$/;
function parseHttpsHeaderField(line: string): { name: string; value: string } {
  const colon = line.indexOf(":");
  const name = line.slice(0, colon).toLowerCase();
  const raw = line.slice(colon + 1);
  if (colon < 1 || !HEADER_NAME.test(name) || !HEADER_VALUE.test(raw)) {
    throw refused();
  }
  return { name, value: raw.trim() };
}
function confirmedUpstream(
  expectedProof: string | undefined,
  observedProof: string | undefined
): Pick<NativeHttpsResponse, "upstreamVerified"> {
  return expectedProof !== undefined && observedProof === expectedProof
    ? { upstreamVerified: true }
    : {};
}
export function parseNativeHttpsHeaders(
  header: string,
  expectedProof?: string
): NativeHttpsResponse {
  if (header.length > 8192 || !header.endsWith("\r\n\r\n")) {
    throw refused();
  }
  const [status, ...lines] = header.slice(0, -4).split("\r\n");
  const match =
    status && status.length < 1024 ? HTTP_STATUS.exec(status) : null;
  if (!match || lines.length > 64) {
    throw refused();
  }
  let location: string | undefined;
  let upstreamProof: string | undefined;
  for (const line of lines) {
    const { name, value } = parseHttpsHeaderField(line);
    if (name === "location") {
      if (location !== undefined || !value || value.length > 2048) {
        throw refused();
      }
      location = value;
    }
    if (name === "x-hack-upstream-proof") {
      if (upstreamProof !== undefined) {
        throw refused();
      }
      upstreamProof = value;
    }
  }
  return {
    statusCode: Number(match[1]),
    ...(location === undefined ? {} : { location }),
    ...confirmedUpstream(expectedProof, upstreamProof),
  };
}
/** One byte budget spans interim and final headers; bodies are never retained. */
function httpsResponseReader(
  upstreamProof: string
): (data: Buffer) => NativeHttpsResponse | undefined {
  let prefix = "";
  let headerBytes = 0;
  let interim = 0;
  return (data) => {
    const part = data.subarray(0, 8192 - headerBytes);
    headerBytes += part.length;
    prefix += part.toString("latin1");
    while (true) {
      const end = prefix.indexOf("\r\n\r\n");
      if (end < 0) {
        if (headerBytes >= 8192) {
          throw refused();
        }
        return undefined;
      }
      const response = parseNativeHttpsHeaders(
        prefix.slice(0, end + 4),
        upstreamProof
      );
      if (response.statusCode >= 200) {
        return response;
      }
      interim++;
      if (response.statusCode === 101 || interim > 4) {
        throw refused();
      }
      prefix = prefix.slice(end + 4);
    }
  };
}
export async function verifyNativeHttpsHostname(
  hostname: string,
  port: number,
  caPath: string,
  path: string,
  verifyPeer?: (peerPort: number) => Promise<void>
): Promise<NativeHttpsResponse> {
  if (
    !isNativeHttpsProbePath(path) ||
    hostname.length > 253 ||
    !HOST.test(hostname) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw refused();
  }
  const ca = await validCa(caPath);
  const upstreamProof = randomBytes(16).toString("hex");
  return await new Promise((resolve, reject) => {
    let settled = false;
    const readResponse = httpsResponseReader(upstreamProof);
    let phase: "handshake" | "response" = "handshake";
    let peerVerified = verifyPeer === undefined;
    const finish = (error?: Error, response?: NativeHttpsResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error || response === undefined) {
        reject(error ?? nativeHttpsVerificationError(undefined));
      } else {
        resolve(response);
      }
    };
    const socket = tlsConnect({
      host: "127.0.0.1",
      port,
      servername: hostname,
      ca,
      rejectUnauthorized: true,
      ALPNProtocols: ["http/1.1"],
    });
    const timer = setTimeout(
      () => finish(nativeHttpsVerificationError(undefined, true, phase)),
      5000
    );
    socket.once("secureConnect", () => {
      void (async () => {
        try {
          await confirmTlsPeer({ verifyPeer, peerPort: socket.localPort });
          if (settled) {
            return;
          }
          peerVerified = true;
          phase = "response";
          const authority = port === 443 ? hostname : `${hostname}:${port}`;
          socket.write(
            `GET ${path} HTTP/1.1\r\nHost: ${authority}\r\nX-Hack-Probe-Request: ${upstreamProof}\r\nConnection: close\r\n\r\n`
          );
        } catch {
          finish(nativeHttpsVerificationError(undefined));
        }
      })();
    });
    socket.on("data", (data: Buffer) => {
      if (!peerVerified) {
        finish(nativeHttpsVerificationError(undefined));
        return;
      }
      // Parse only bounded headers; discard any body bytes delivered in the same chunk.
      try {
        const response = readResponse(data);
        if (response !== undefined) {
          finish(undefined, response);
        }
      } catch {
        finish(nativeHttpsVerificationError(undefined));
      }
    });
    socket.once("error", (error: unknown) =>
      finish(nativeHttpsVerificationError(error))
    );
    socket.once("close", () => finish(nativeHttpsVerificationError(undefined)));
  });
}

async function waitReady<T>(
  deadline: number,
  dead: () => boolean,
  check: () => Promise<T>,
  failure?: () => Promise<NativeRuntimeRequestError | undefined> | undefined
): Promise<T> {
  while (Date.now() < deadline && !dead()) {
    try {
      const result = await check();
      if (!dead()) {
        return result;
      }
    } catch {
      /* Endpoint publication is bounded by the shared startup deadline. */
    }
    await Bun.sleep(50);
  }
  throw (dead() && (await failure?.())) || refused();
}
/** Owns only newly spawned children; preserves CA data and never installs host trust. */
export async function startNativeProjectHttps(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly caddyBinary: string;
  readonly caddySha256: string;
  readonly httpsPort: number;
  readonly certificateNameLimit?: number;
  readonly dependencies?: Partial<Dependencies>;
}): Promise<{
  readonly caPath: string;
  readonly httpsPort: number;
  readonly exited: Promise<{ component: string; code: number }>;
  verifyHostname(hostname: string, path: string): Promise<NativeHttpsResponse>;
  close(): Promise<void>;
}> {
  const deps = {
    checkPort: checkNativeHttpsPort,
    invoke: invokeNativeRuntime,
    spawn: spawnNativeHttpsChild,
    permissionPort,
    adminReady,
    afterOwnerSocketPublish: async () => undefined,
    ...opts.dependencies,
  };
  const limit = opts.certificateNameLimit ?? 256;
  if (
    !(
      isAbsolute(opts.caddyBinary) &&
      SHA.test(opts.caddySha256) &&
      Number.isInteger(opts.httpsPort)
    ) ||
    opts.httpsPort < 1 ||
    opts.httpsPort > 65_535 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 4096
  ) {
    throw refused();
  }
  if (
    (await nativeExecutableDigests.sha256(opts.caddyBinary, {
      refused,
      singleLink: true,
    })) !== opts.caddySha256
  ) {
    throw refused();
  }
  const home = await realpath(opts.runtime.home);
  if (home !== opts.runtime.home) {
    throw refused();
  }
  await deps.checkPort(opts.httpsPort);
  await privateDirectory(home);
  const storage = join(home, "native-https");
  await privateDirectory(storage);
  const data = join(storage, "data");
  await privateDirectory(data);
  const lock = join(storage, "owner.lock");
  const receiptPath = join(storage, OWNER_RECEIPT);
  const ownerSocket = join(storage, OWNER_SOCKET);
  await mkdir(lock, { mode: 0o700 });
  const lockIdentity = await lstat(lock);
  let owner: Awaited<ReturnType<typeof startOwnerChallenge>> | undefined;
  let session: string | undefined;
  let sessionIdentity: { dev: number; ino: number } | undefined;
  let authority: HttpsChild | undefined;
  let caddy: HttpsChild | undefined;
  let closed: Promise<void> | undefined;
  let ownedAuthority: { socket: string; sha256: string } | undefined;
  let receiptIdentity:
    | { readonly dev: number; readonly ino: number; readonly sha256: string }
    | undefined;
  const inspect = () =>
    deps.invoke({
      runtime: opts.runtime,
      cwd: home,
      args: ["runtime", "managed-hostname-authority", "--json"],
      timeoutMs: 5000,
    });
  const closeOwner = async () => {
    if (owner) {
      await stopOwnerChallenge({
        path: ownerSocket,
        server: owner.server,
        identity: owner.identity,
      });
      return;
    }
    try {
      await lstat(ownerSocket);
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") {
        return;
      }
    }
    throw refused();
  };
  const close = () =>
    (closed ??= (async () => {
      const results = await Promise.allSettled([
        closeOwner(),
        caddy ? stop(caddy, false) : Promise.resolve(),
        authority
          ? stopAuthority({
              child: authority,
              owned: ownedAuthority,
              invoke: deps.invoke,
              runtime: opts.runtime,
              home,
            })
          : Promise.resolve(),
      ]);
      if (results.some((result) => result.status === "rejected")) {
        throw refused();
      }
      if (authority) {
        await retireAuthority({
          inspect,
          invoke: deps.invoke,
          runtime: opts.runtime,
          home,
          owned: ownedAuthority,
        });
      }
      if (receiptIdentity) {
        await retireOwnerReceipt({
          path: receiptPath,
          identity: receiptIdentity,
        });
      }
      if (session) {
        await removeOwnedDirectory(session, sessionIdentity, true);
      }
      await removeOwnedDirectory(lock, lockIdentity, false);
    })());
  let startupStage: ConstructorParameters<typeof NativeHttpsStartupError>[0] =
    "owner-challenge";
  try {
    owner = await startOwnerChallenge(
      ownerSocket,
      deps.afterOwnerSocketPublish
    );
    startupStage = "authority-observation";
    const before = await inspect();
    if (
      !(
        isRecord(before) &&
        typeof before.socket === "string" &&
        isRecord(before.authority) &&
        before.authority.present === false
      )
    ) {
      throw refused();
    }
    session = await mkdtemp(join(await realpath(tmpdir()), "hk-https-"));
    await privateDirectory(session);
    sessionIdentity = await lstat(session);
    // Caddy's admin socket. The authority is told it from the start: whenever it
    // stops serving it asks this Caddy to stop too, so an owner that was killed
    // leaves neither child running (HACK-2720). `hack-native` ships with this
    // CLI and the owner binding pins its hash; a runtime without the flag would
    // refuse this argv, so the start fails closed at authority-ready.
    const admin = join(session, "admin.sock");
    const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: home };
    startupStage = "authority-start";
    authority = deps.spawn({
      argv: [
        opts.runtime.binary,
        "--candidate-root",
        home,
        "runtime",
        "serve-managed-hostnames",
        "--certificate-name-limit",
        String(limit),
        "--caddy-admin-socket",
        admin,
      ],
      env,
      pipe: true,
      nativeDiagnostics: true,
    });
    let dead = false;
    const startedAuthority = authority;
    void startedAuthority.exited.then(() => {
      dead = true;
    });
    // One shared deadline for the authority (its lease wait included) and Caddy.
    const deadline = Date.now() + NATIVE_HTTPS_CHILD_STARTUP_MS;
    startupStage = "authority-ready";
    ownedAuthority = await waitReady(
      deadline,
      () => dead,
      async () => authorityIdentity(await inspect(), startedAuthority.pid),
      () => startedAuthority.failure
    );
    startupStage = "authority-identity";
    const socket = ownedAuthority.socket;
    if (socket !== before.socket) {
      throw refused();
    }
    startupStage = "permission-port";
    const permission = await deps.permissionPort();
    if (permission === opts.httpsPort) {
      throw refused();
    }
    startupStage = "caddy-configuration";
    const filename = join(session, "Caddyfile");
    await writeFile(
      filename,
      config({
        admin,
        authority: socket,
        httpsPort: opts.httpsPort,
        permissionPort: permission,
      }),
      { mode: 0o600, flag: "wx" }
    );
    startupStage = "caddy-start";
    caddy = deps.spawn({
      argv: [
        opts.caddyBinary,
        "run",
        "--config",
        filename,
        "--adapter",
        "caddyfile",
      ],
      env: {
        PATH: "/usr/bin:/bin",
        HOME: session,
        XDG_DATA_HOME: data,
        XDG_CONFIG_HOME: join(session, "config"),
        XDG_CACHE_HOME: join(session, "cache"),
      },
      pipe: false,
    });
    void caddy.exited.then(() => {
      dead = true;
    });
    startupStage = "caddy-ready";
    const caPath = join(data, "caddy/pki/authorities/local/root.crt");
    await waitReady(
      deadline,
      () => dead,
      async () => {
        const endpoint = await lstat(admin);
        if (
          !endpoint.isSocket() ||
          endpoint.uid !== process.getuid?.() ||
          (endpoint.mode & 0o777) !== 0o600 ||
          !(await deps.adminReady(admin))
        ) {
          throw refused();
        }
        await validCa(caPath);
      }
    );
    startupStage = "listener-verification";
    const listener = await inspectHostListener({
      runtime: opts.runtime,
      invoke: deps.invoke,
      pid: caddy.pid,
      port: opts.httpsPort,
      executable: opts.caddyBinary,
    });
    const caSha256 = caDerSha256(await validCa(caPath));
    startupStage = "owner-publication";
    receiptIdentity = await publishOwnerReceipt({
      path: receiptPath,
      receipt: {
        version: 1,
        listener,
        caddySha256: opts.caddySha256,
        caSha256,
        authority: {
          pid: authority.pid,
          socket: ownedAuthority.socket,
          sha256: ownedAuthority.sha256,
        },
        lock: { dev: lockIdentity.dev, ino: lockIdentity.ino },
        owner: {
          publicKey: owner.publicKey,
          dev: owner.identity.dev,
          ino: owner.identity.ino,
        },
      },
    });
    startupStage = "owner-verification";
    const activeOwner = await inspectActiveNativeHttpsOwner({
      runtime: opts.runtime,
      invoke: deps.invoke,
    });
    const exited = Promise.race([
      authority.exited.then((code) => ({ component: "authority", code })),
      caddy.exited.then((code) => ({ component: "caddy", code })),
    ]);
    return {
      caPath,
      httpsPort: opts.httpsPort,
      exited,
      verifyHostname: (hostname, path) =>
        verifyNativeHttpsHostname(
          hostname,
          opts.httpsPort,
          caPath,
          path,
          (peerPort) =>
            verifyActiveNativeHttpsConnection({
              runtime: opts.runtime,
              owner: activeOwner,
              peerPort,
              invoke: deps.invoke,
            })
        ),
      close,
    };
  } catch (error) {
    let cleanupUnconfirmed = false;
    try {
      await close();
    } catch {
      cleanupUnconfirmed = true;
    }
    throw new NativeHttpsStartupError(startupStage, error, cleanupUnconfirmed);
  }
}
