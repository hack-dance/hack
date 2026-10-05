import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  X509Certificate,
} from "node:crypto";
import { closeSync, constants, mkdtempSync, openSync, rmSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
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
import { isRecord } from "../lib/guards.ts";
import { listenPublishedUnixSocket } from "../lib/unix-socket-publish.ts";
import { checkNativeHttpsPort } from "./native-https-port.ts";
import { NativeHttpsStartupError } from "./native-https-startup-failure.ts";
import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
  readNativeFailureCode,
} from "./native-runtime-client.ts";

const PROBE_PATH_BYTES = /^[\x21-\x7e]+$/;
const HTTP_STATUS = /^HTTP\/1\.[01] ([2-5][0-9]{2})(?: [^\r\n]*)?$/;
const SHA = /^[a-f0-9]{64}$/;
const SINGLE_CERTIFICATE =
  /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/;
const OWNER_RECEIPT = "active-owner.json";
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
  return new Error(
    `Native HTTPS verification failed (${code}); peer values omitted.`
  );
}
function refused(): Error {
  return new Error(
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
      env: input.env,
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
  request_header -X-Hack-Endpoint
  forward_auth ${quoted(`unix/${opts.authority}`)} {
   uri /route?
   copy_headers X-Hack-Endpoint
  }
  reverse_proxy unix/{http.request.header.X-Hack-Endpoint} {
   header_up Host {hostport}
   header_up -X-Hack-Endpoint
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
    const caddyMetadata = await lstat(receipt.listener.executable);
    if (
      !caddyMetadata.isFile() ||
      (caddyMetadata.mode & 0o022) !== 0 ||
      (caddyMetadata.mode & 0o111) === 0 ||
      (await realpath(receipt.listener.executable)) !==
        receipt.listener.executable ||
      createHash("sha256")
        .update(
          await boundedFile(receipt.listener.executable, 256 * 1024 * 1024)
        )
        .digest("hex") !== receipt.caddySha256
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
export function parseNativeHttpsHeaders(header: string): NativeHttpsResponse {
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
  for (const line of lines) {
    const colon = line.indexOf(":");
    const name = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (
      colon < 1 ||
      !HEADER_NAME.test(name) ||
      !HEADER_VALUE.test(line.slice(colon + 1))
    ) {
      throw refused();
    }
    if (name === "location") {
      if (location !== undefined || !value || value.length > 2048) {
        throw refused();
      }
      location = value;
    }
  }
  return {
    statusCode: Number(match[1]),
    ...(location === undefined ? {} : { location }),
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
  return await new Promise((resolve, reject) => {
    let settled = false;
    let prefix = "";
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
            `GET ${path} HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`
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
      prefix += data.subarray(0, 8192 - prefix.length).toString("latin1");
      const end = prefix.indexOf("\r\n\r\n");
      if (end < 0 && prefix.length < 8192) {
        return;
      }
      try {
        finish(undefined, parseNativeHttpsHeaders(prefix.slice(0, end + 4)));
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
  const metadata = await lstat(opts.caddyBinary);
  if (
    !metadata.isFile() ||
    (metadata.mode & 0o022) !== 0 ||
    (metadata.mode & 0o111) === 0 ||
    (await realpath(opts.caddyBinary)) !== opts.caddyBinary ||
    createHash("sha256")
      .update(await boundedFile(opts.caddyBinary, 256 * 1024 * 1024))
      .digest("hex") !== opts.caddySha256
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
    const deadline = Date.now() + 10_000;
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
    const admin = join(session, "admin.sock");
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
