import { createHash, X509Certificate } from "node:crypto";
import { closeSync, constants, mkdtempSync, openSync, rmSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isRecord } from "../lib/guards.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const SHA = /^[a-f0-9]{64}$/;
const HOST =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export interface HttpsChild {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  endInput(): void;
}
interface SpawnInput {
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
  readonly pipe: boolean;
}
interface Dependencies {
  readonly invoke: typeof invokeNativeRuntime;
  readonly spawn: (input: SpawnInput) => HttpsChild;
  readonly permissionPort: () => Promise<number>;
  readonly adminReady: (socket: string) => Promise<boolean>;
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
      stderr: "ignore",
    });
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
async function boundedFile(path: string, limit: number): Promise<Buffer> {
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
      before.size > limit
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
  child: HttpsChild
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
      record.process.pid === child.pid
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
async function verifyHostname(
  hostname: string,
  port: number,
  caPath: string
): Promise<{ statusCode: number }> {
  if (hostname.length > 253 || !HOST.test(hostname)) {
    throw refused();
  }
  const ca = await validCa(caPath);
  return await new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const req = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        servername: hostname,
        headers: { Host: port === 443 ? hostname : `${hostname}:${port}` },
        path: "/",
        ca,
        rejectUnauthorized: true,
        timeout: 5000,
      },
      (response) => {
        if (timer) {
          clearTimeout(timer);
        }
        const statusCode = response.statusCode;
        response.destroy();
        if (statusCode === undefined) {
          reject(refused());
        } else {
          resolve({ statusCode });
        }
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(refused());
    });
    timer = setTimeout(() => req.destroy(refused()), 5000);
    req.end();
  });
}
async function waitReady<T>(
  deadline: number,
  dead: () => boolean,
  check: () => Promise<T>
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
  throw refused();
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
  verifyHostname(hostname: string): Promise<{ statusCode: number }>;
  close(): Promise<void>;
}> {
  const deps = {
    invoke: invokeNativeRuntime,
    spawn: spawnNativeHttpsChild,
    permissionPort,
    adminReady,
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
  await privateDirectory(home);
  const storage = join(home, "native-https");
  await privateDirectory(storage);
  const data = join(storage, "data");
  await privateDirectory(data);
  const lock = join(storage, "owner.lock");
  await mkdir(lock, { mode: 0o700 });
  const lockIdentity = await lstat(lock);
  let session: string | undefined;
  let sessionIdentity: { dev: number; ino: number } | undefined;
  let authority: HttpsChild | undefined;
  let caddy: HttpsChild | undefined;
  let closed: Promise<void> | undefined;
  let ownedAuthority: { socket: string; sha256: string } | undefined;
  const inspect = () =>
    deps.invoke({
      runtime: opts.runtime,
      cwd: home,
      args: ["runtime", "managed-hostname-authority", "--json"],
      timeoutMs: 5000,
    });
  const close = () =>
    (closed ??= (async () => {
      const results = await Promise.allSettled([
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
      if (session) {
        await removeOwnedDirectory(session, sessionIdentity, true);
      }
      await removeOwnedDirectory(lock, lockIdentity, false);
    })());
  try {
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
    });
    let dead = false;
    void authority.exited.then(() => {
      dead = true;
    });
    const deadline = Date.now() + 10_000;
    const startedAuthority = authority;
    ownedAuthority = await waitReady(
      deadline,
      () => dead,
      async () => authorityIdentity(await inspect(), startedAuthority)
    );
    const socket = ownedAuthority.socket;
    if (socket !== before.socket) {
      throw refused();
    }
    const permission = await deps.permissionPort();
    if (permission === opts.httpsPort) {
      throw refused();
    }
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
    const exited = Promise.race([
      authority.exited.then((code) => ({ component: "authority", code })),
      caddy.exited.then((code) => ({ component: "caddy", code })),
    ]);
    return {
      caPath,
      httpsPort: opts.httpsPort,
      exited,
      verifyHostname: (hostname) =>
        verifyHostname(hostname, opts.httpsPort, caPath),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
