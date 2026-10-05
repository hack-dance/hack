import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NativeHttpsStartupError } from "../src/backends/native-https-startup-failure.ts";
import {
  captureNativeHttpsChildFailure,
  type HttpsChild,
  inspectActiveNativeHttpsOwner,
  isNativeHttpsProbePath,
  nativeHttpsVerificationError,
  parseNativeHttpsHeaders,
  spawnNativeHttpsChild,
  startNativeProjectHttps,
  verifyActiveNativeHttpsConnection,
  verifyNativeHttpsHostname,
} from "../src/backends/native-project-https.ts";
import { NativeRuntimeRequestError } from "../src/backends/native-runtime-client.ts";
import { CURRENT_CA_PEM, OLD_CA_PEM } from "./helpers/ca-certificates.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "https-test-"));
  await chmod(root, 0o700);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "caddy");
  await writeFile(binary, "synthetic executable", { mode: 0o700 });
  const socket = join(root, "route.sock");
  const children: Array<{ child: HttpsChild; finish: (code: number) => void }> =
    [];
  const servers: Server[] = [];
  cleanups.push(async () => {
    for (const server of servers) {
      await new Promise<void>((resolve) => {
        if (server.listening) {
          server.close(() => resolve());
        } else {
          resolve();
        }
      });
    }
  });
  let inspectCount = 0;
  let authorityExited = false;
  let configText = "";
  let foreign = false;
  let failCaddy = false;
  let wrongIdentity = false;
  let wrongListener = false;
  let wrongPeer = false;
  let peerAccepted = true;
  const peerProofCalls: string[][] = [];
  const events: string[] = [];
  const deps: NonNullable<
    Parameters<typeof startNativeProjectHttps>[0]["dependencies"]
  > = {
    checkPort: async () => {},
    permissionPort: async () => 18_443,
    adminReady: async () => true,
    invoke: async (request) => {
      if (request.args[1] === "inspect-host-listener") {
        const peer = request.args.includes("--peer-port");
        if (peer) {
          peerProofCalls.push([...request.args]);
        }
        return {
          pid: 1001,
          start_micros: 1_700_000_000_000_000,
          uid: process.getuid?.(),
          executable: binary,
          port: 443,
          fingerprint:
            wrongListener || (peer && wrongPeer)
              ? "f".repeat(64)
              : "a".repeat(64),
          ...(peer ? { accepted: peerAccepted } : {}),
        };
      }
      if (request.args[1] === "stop-hostname-authority") {
        expect(request.args).toEqual([
          "runtime",
          "stop-hostname-authority",
          "--socket",
          socket,
          "--expect-sha256",
          hash(await readFile(`${socket}.identity`)),
          "--json",
        ]);
        events.push("0:cooperative-stop");
        children[0]?.finish(0);
        return { stopped: true, process_exit_observed: true };
      }
      inspectCount++;
      if (authorityExited) {
        return { socket, authority: { present: false } };
      }
      if (inspectCount === 1) {
        return { socket, authority: { present: foreign } };
      }
      if (wrongIdentity) {
        writeFileSync(
          `${socket}.identity`,
          JSON.stringify({ process: { pid: 99_999 } }),
          { mode: 0o600 }
        );
        setTimeout(() => children[0]?.finish(1), 10);
      }
      const bytes = await readFile(`${socket}.identity`);
      return {
        socket,
        authority: {
          present: true,
          process_present: true,
          socket_present: true,
          sha256: hash(bytes),
        },
      };
    },
    spawn: (input) => {
      const index = children.length;
      let resolveExit: (code: number) => void = () => {};
      const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
      });
      let server: Server | undefined;
      const finish = (code: number) => {
        if (input.pipe) {
          authorityExited = true;
        }
        if (server?.listening) {
          server.close(() => resolveExit(code));
        } else {
          resolveExit(code);
        }
      };
      const child: HttpsChild = {
        pid: 1000 + index,
        exited,
        kill: (signal) => {
          events.push(`${index}:${signal}`);
          finish(signal === "SIGKILL" ? 137 : 0);
        },
        endInput: () => {
          events.push(`${index}:EOF`);
          finish(0);
        },
      };
      children.push({ child, finish });
      if (input.pipe) {
        expect(input.argv).toContain("serve-managed-hostnames");
        server = createServer();
        servers.push(server);
        server.listen(socket, () => chmodSync(socket, 0o600));
        writeFileSync(
          `${socket}.identity`,
          JSON.stringify({ process: { pid: child.pid } }),
          { mode: 0o600 }
        );
      } else {
        if (failCaddy) {
          finish(1);
          return child;
        }
        const filename = input.argv[input.argv.indexOf("--config") + 1];
        if (!filename) {
          throw new Error("missing config");
        }
        configText = readFileSync(filename, "utf8");
        const admin = join(dirname(filename), "admin.sock");
        server = createServer();
        servers.push(server);
        server.listen(admin, () => chmodSync(admin, 0o600));
        const ca = join(
          input.env.XDG_DATA_HOME ?? "",
          "caddy/pki/authorities/local/root.crt"
        );
        mkdirSync(dirname(ca), { recursive: true, mode: 0o700 });
        writeFileSync(ca, CURRENT_CA_PEM, { mode: 0o600 });
      }
      return child;
    },
  };
  const opts = {
    runtime: { binary: join(root, "hack-native"), home: root },
    caddyBinary: binary,
    caddySha256: hash("synthetic executable"),
    httpsPort: 443,
    dependencies: deps,
  };
  return {
    root,
    opts,
    events,
    children,
    config: () => configText,
    wrongIdentity: () => {
      wrongIdentity = true;
    },
    wrongListener: () => {
      wrongListener = true;
    },
    wrongPeer: () => {
      wrongPeer = true;
    },
    rejectPeer: () => {
      peerAccepted = false;
    },
    peerProofCalls,
    foreign: () => {
      foreign = true;
    },
    fail: () => {
      failCaddy = true;
    },
  };
}

test("owns authority and Caddy lifetimes, writes strict routing config and preserves CA", async () => {
  const f = await fixture();
  const running = await startNativeProjectHttps(f.opts);
  cleanups.push(() => running.close());
  expect(f.config()).toContain("strict_sni_host on");
  expect(f.config()).toContain("skip_install_trust");
  expect(f.config()).toContain("uri /route?");
  expect(f.config()).toContain("request_header -X-Hack-Endpoint");
  expect(f.config()).toContain("header_up -X-Hack-Endpoint");
  expect(f.config()).toContain("https://:443");
  expect(f.config()).toContain("bind 127.0.0.1");
  expect(f.config()).toContain("permission http http://127.0.0.1:18443/ask");
  const owner = await inspectActiveNativeHttpsOwner({
    runtime: f.opts.runtime,
    invoke: f.opts.dependencies.invoke,
  });
  expect(owner).toMatchObject({
    caPath: running.caPath,
    httpsPort: 443,
    listenerFingerprint: "a".repeat(64),
    caddyPid: 1001,
    caddyBinary: f.opts.caddyBinary,
  });
  await running.close();
  await running.close();
  expect(f.events).toEqual(["1:SIGTERM", "0:cooperative-stop", "0:EOF"]);
  expect(await readFile(running.caPath, "utf8")).toBe(CURRENT_CA_PEM);
  await expect(
    access(join(f.root, "native-https/owner.lock"))
  ).rejects.toThrow();
  await expect(
    access(join(f.root, "native-https/active-owner.json"))
  ).rejects.toThrow();
});
test("owner receipt verifier refuses a replaced listener", async () => {
  const f = await fixture();
  const running = await startNativeProjectHttps(f.opts);
  cleanups.push(() => running.close());
  f.wrongListener();
  await expect(
    inspectActiveNativeHttpsOwner({
      runtime: f.opts.runtime,
      invoke: f.opts.dependencies.invoke,
    })
  ).rejects.toThrow("ownership verification failed");
});
test("peer proof requires the accepted socket and exact receipted listener", async () => {
  const f = await fixture();
  const running = await startNativeProjectHttps(f.opts);
  cleanups.push(() => running.close());
  const owner = await inspectActiveNativeHttpsOwner({
    runtime: f.opts.runtime,
    invoke: f.opts.dependencies.invoke,
  });
  await verifyActiveNativeHttpsConnection({
    runtime: f.opts.runtime,
    owner,
    peerPort: 52_341,
    invoke: f.opts.dependencies.invoke,
  });
  expect(f.peerProofCalls).toContainEqual([
    "runtime",
    "inspect-host-listener",
    "--pid",
    "1001",
    "--port",
    "443",
    "--executable",
    f.opts.caddyBinary,
    "--peer-port",
    "52341",
    "--json",
  ]);
  f.wrongPeer();
  await expect(
    verifyActiveNativeHttpsConnection({
      runtime: f.opts.runtime,
      owner,
      peerPort: 52_342,
      invoke: f.opts.dependencies.invoke,
    })
  ).rejects.toThrow("ownership verification failed");
  const other = await fixture();
  const otherRunning = await startNativeProjectHttps(other.opts);
  cleanups.push(() => otherRunning.close());
  const otherOwner = await inspectActiveNativeHttpsOwner({
    runtime: other.opts.runtime,
    invoke: other.opts.dependencies.invoke,
  });
  other.rejectPeer();
  await expect(
    verifyActiveNativeHttpsConnection({
      runtime: other.opts.runtime,
      owner: otherOwner,
      peerPort: 52_343,
      invoke: other.opts.dependencies.invoke,
    })
  ).rejects.toThrow("ownership verification failed");
});
test("owner receipt verifier refuses CA rotation", async () => {
  const f = await fixture();
  const running = await startNativeProjectHttps(f.opts);
  cleanups.push(() => running.close());
  await writeFile(running.caPath, OLD_CA_PEM);
  await expect(
    inspectActiveNativeHttpsOwner({
      runtime: f.opts.runtime,
      invoke: f.opts.dependencies.invoke,
    })
  ).rejects.toThrow("ownership verification failed");
});
test("owner receipt verifier refuses a dead frontend challenge even while children remain", async () => {
  const f = await fixture();
  const running = await startNativeProjectHttps(f.opts);
  cleanups.push(() => running.close());
  await rm(join(f.root, "native-https/owner.sock"));
  await expect(
    inspectActiveNativeHttpsOwner({
      runtime: f.opts.runtime,
      invoke: f.opts.dependencies.invoke,
    })
  ).rejects.toThrow("ownership verification failed");
});
test("owner receipt verifier refuses malformed or publicly readable receipts", async () => {
  const f = await fixture();
  const running = await startNativeProjectHttps(f.opts);
  cleanups.push(() => running.close());
  const receipt = join(f.root, "native-https/active-owner.json");
  const original = await readFile(receipt);
  await writeFile(receipt, "{}");
  await expect(
    inspectActiveNativeHttpsOwner({
      runtime: f.opts.runtime,
      invoke: f.opts.dependencies.invoke,
    })
  ).rejects.toThrow("ownership verification failed");
  await writeFile(receipt, original);
  await chmod(receipt, 0o644);
  await expect(
    inspectActiveNativeHttpsOwner({
      runtime: f.opts.runtime,
      invoke: f.opts.dependencies.invoke,
    })
  ).rejects.toThrow("ownership verification failed");
  await chmod(receipt, 0o600);
});
test("owner challenge refuses a valid receipt with a different signing key", async () => {
  const f = await fixture();
  const running = await startNativeProjectHttps(f.opts);
  cleanups.push(() => running.close());
  const receipt = join(f.root, "native-https/active-owner.json");
  const original = await readFile(receipt);
  const parsed = JSON.parse(original.toString("utf8"));
  const foreign = generateKeyPairSync("ed25519");
  parsed.owner.publicKey = foreign.publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  await writeFile(receipt, JSON.stringify(parsed));
  await expect(
    inspectActiveNativeHttpsOwner({
      runtime: f.opts.runtime,
      invoke: f.opts.dependencies.invoke,
    })
  ).rejects.toThrow("ownership verification failed");
  await writeFile(receipt, original);
});
test("owner socket preparation failure retires only its bound socket and lock", async () => {
  const f = await fixture();
  await expect(
    startNativeProjectHttps({
      ...f.opts,
      dependencies: {
        ...f.opts.dependencies,
        afterOwnerSocketPublish: async () => {
          throw new Error("simulated socket preparation failure");
        },
      },
    })
  ).rejects.toThrow("startup failed (owner-challenge)");
  expect(f.children).toHaveLength(0);
  await expect(
    access(join(f.root, "native-https/owner.lock"))
  ).rejects.toThrow();
  await expect(
    access(join(f.root, "native-https/owner.sock"))
  ).rejects.toThrow();
});
test("refuses foreign authority without spawning or terminating any process", async () => {
  const f = await fixture();
  f.foreign();
  await expect(startNativeProjectHttps(f.opts)).rejects.toThrow();
  expect(f.children).toHaveLength(0);
  expect(f.events).toEqual([]);
});
test("invalid executable pin, aliases and unsafe ports refuse before processes", async () => {
  const f = await fixture();
  await expect(
    startNativeProjectHttps({ ...f.opts, caddySha256: "0".repeat(64) })
  ).rejects.toThrow();
  const alias = join(f.root, "alias");
  await symlink(f.opts.caddyBinary, alias);
  await expect(
    startNativeProjectHttps({ ...f.opts, caddyBinary: alias })
  ).rejects.toThrow();
  for (const httpsPort of [0, 65_536, 1.5]) {
    await expect(
      startNativeProjectHttps({ ...f.opts, httpsPort })
    ).rejects.toThrow();
  }
  expect(f.children).toHaveLength(0);
});
test("startup child failure closes only its owned authority and retains persistent data", async () => {
  const f = await fixture();
  f.fail();
  await expect(startNativeProjectHttps(f.opts)).rejects.toThrow();
  expect(f.events).toContain("0:EOF");
  await access(join(f.root, "native-https/data"));
});
test("exclusive lifetime refuses a second owner and reports child exit", async () => {
  const f = await fixture();
  const running = await startNativeProjectHttps(f.opts);
  cleanups.push(() => running.close());
  await expect(startNativeProjectHttps(f.opts)).rejects.toThrow();
  expect(f.children).toHaveLength(2);
  f.children[1]?.finish(23);
  expect(await running.exited).toEqual({ component: "caddy", code: 23 });
  await running.close();
});

test("a mismatched authority PID cannot authorize Caddy startup", async () => {
  const f = await fixture();
  f.wrongIdentity();
  await expect(startNativeProjectHttps(f.opts)).rejects.toThrow();
  expect(f.children).toHaveLength(1);
  expect(f.events).toContain("0:EOF");
});

test("default authority child receives a real FIFO and remains owned until EOF", async () => {
  const directory = await mkdtemp(join(tmpdir(), "https-fifo-test-"));
  const marker = join(directory, "ready");
  const child = spawnNativeHttpsChild({
    argv: [
      process.execPath,
      "-e",
      "const fs=require('node:fs'); if(!fs.fstatSync(0).isFIFO())process.exit(42); fs.writeFileSync(process.argv[1],'fifo'); const b=Buffer.alloc(1); while(fs.readSync(0,b,0,1,null)>0){}",
      marker,
    ],
    env: { PATH: "/usr/bin:/bin" },
    pipe: true,
  });
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await Bun.file(marker).exists()) {
        break;
      }
      await Bun.sleep(10);
    }
    expect(await readFile(marker, "utf8")).toBe("fifo");
    let finished = false;
    void child.exited.then(() => {
      finished = true;
    });
    await Bun.sleep(20);
    expect(finished).toBe(false);
    child.endInput();
    expect(
      await Promise.race([child.exited, Bun.sleep(2000).then(() => -1)])
    ).toBe(0);
  } finally {
    child.endInput();
    child.kill("SIGKILL");
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
});

test("native shell owner observes FIFO EOF without inherited writer", async () => {
  const child = spawnNativeHttpsChild({
    argv: ["/bin/sh", "-c", "test -p /dev/stdin || exit 42; cat >/dev/null"],
    env: { PATH: "/usr/bin:/bin" },
    pipe: true,
  });
  try {
    await Bun.sleep(30);
    child.endInput();
    expect(
      await Promise.race([child.exited, Bun.sleep(2000).then(() => -1)])
    ).toBe(0);
  } finally {
    child.endInput();
    child.kill("SIGKILL");
    await child.exited;
  }
});

for (const changed of [false, true]) {
  test(`shutdown ${changed ? "refuses changed" : "recovers exact dead"} authority receipt`, async () => {
    const { opts, root } = await fixture();
    const invoke = opts.dependencies.invoke!;
    let stale = false;
    let recovered = false;
    let observed:
      | {
          socket: string;
          authority: {
            present: boolean;
            sha256: string;
            process_present: boolean;
            socket_present: boolean;
          };
        }
      | undefined;
    opts.dependencies = {
      ...opts.dependencies,
      invoke: async (request) => {
        if (request.args[1] === "recover-hostname-authority") {
          expect(changed).toBe(false);
          expect(request.args).toContain(observed!.authority.sha256);
          recovered = true;
          stale = false;
          return {};
        }
        const result = await invoke(request);
        if (
          !stale &&
          result &&
          typeof result === "object" &&
          "authority" in result &&
          (result as typeof observed)?.authority.sha256
        ) {
          observed = result as typeof observed;
        }
        if (stale) {
          return {
            ...observed,
            authority: {
              ...observed!.authority,
              process_present: false,
              sha256: changed ? "f".repeat(64) : observed!.authority.sha256,
            },
          };
        }
        return result;
      },
    };
    const frontend = await startNativeProjectHttps(opts);
    stale = true;
    if (changed) {
      await expect(frontend.close()).rejects.toThrow(
        "ownership verification failed"
      );
      expect(recovered).toBe(false);
      await access(join(root, "native-https/owner.lock"));
    } else {
      await frontend.close();
      expect(recovered).toBe(true);
      await expect(
        access(join(root, "native-https/owner.lock"))
      ).rejects.toThrow();
    }
  });
}

test("HTTPS port refusal happens before authority or certificate state is created", async () => {
  const f = await fixture();
  await expect(
    startNativeProjectHttps({
      ...f.opts,
      dependencies: {
        ...f.opts.dependencies,
        checkPort: async () => {
          throw new Error("Native HTTPS port 443 requires host permission.");
        },
      },
    })
  ).rejects.toThrow("requires host permission");
  expect(f.children).toHaveLength(0);
  await expect(access(join(f.root, "native-https"))).rejects.toThrow();
});

test("HTTPS errors preserve only reviewed codes and distinguish wall timeouts", () => {
  for (const code of [
    "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR",
    "ECONNREFUSED",
    "ERR_TLS_CERT_ALTNAME_INVALID",
  ]) {
    const error = nativeHttpsVerificationError({
      code,
      message: "secret peer URL",
      stack: "secret trace",
    });
    expect(error.message).toContain(code);
    expect(error.message).not.toContain("secret");
  }
  expect(
    nativeHttpsVerificationError({ code: "secret-value", message: "secret" })
      .message
  ).toContain("TLS_OR_TRANSPORT_ERROR");
  expect(
    nativeHttpsVerificationError(new Error("secret")).message
  ).not.toContain("secret");
  expect(
    nativeHttpsVerificationError({ code: "ECONNRESET" }, true).message
  ).toContain("VERIFICATION_TIMEOUT");
});

test("verification timeouts identify handshake versus HTTP response", () => {
  expect(
    nativeHttpsVerificationError(undefined, true, "handshake").message
  ).toContain("VERIFICATION_TIMEOUT_HANDSHAKE");
  expect(
    nativeHttpsVerificationError(undefined, true, "response").message
  ).toContain("VERIFICATION_TIMEOUT_RESPONSE");
});

test("real TLS verification pins loopback, SNI, Host and CA and bounds status parsing", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "https-wire-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cert = join(root, "cert.pem");
  const key = join(root, "key.pem");
  const generated = spawnSync(
    "/usr/bin/openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=fixture.invalid",
      "-addext",
      "subjectAltName=DNS:fixture.invalid",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdio: "ignore", timeout: 10_000 }
  );
  expect(generated.status).toBe(0);
  const responsePath = join(root, "response");
  const seenPath = join(root, "seen");
  await writeFile(
    responsePath,
    "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n"
  );
  const script = join(root, "server.py");
  await writeFile(
    script,
    String.raw`import json,socket,ssl,sys,pathlib
root=pathlib.Path(sys.argv[1])
context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(str(root/'cert.pem'),str(root/'key.pem'))
seen={}
def sni(sock,name,ctx): seen['sni']=name
context.set_servername_callback(sni)
server=socket.socket();server.bind(('127.0.0.1',0));server.listen(8)
print(server.getsockname()[1],flush=True)
while True:
 client,remote=server.accept()
 try:
  with context.wrap_socket(client,server_side=True) as conn:
   conn.settimeout(3)
   data=b''
   while b'\r\n\r\n' not in data:
    chunk=conn.recv(4096)
    if not chunk: break
    data+=chunk
   if data:
    seen.update(request=data.decode(),remote=remote[0],remote_port=remote[1])
    (root/'seen').write_text(json.dumps(seen))
    conn.sendall((root/'response').read_bytes())
 except (OSError,ssl.SSLError): client.close()
`
  );
  const child = Bun.spawn(["python3", "-I", "-S", script, root], {
    stdout: "pipe",
    stderr: "ignore",
  });
  cleanups.push(async () => {
    child.kill();
    await child.exited;
  });
  const reader = child.stdout.getReader();
  const announced = await reader.read();
  reader.releaseLock();
  const port = Number(new TextDecoder().decode(announced.value).trim());
  expect(Number.isInteger(port) && port > 0).toBe(true);
  const address = { port };
  expect(
    await verifyNativeHttpsHostname(
      "fixture.invalid",
      address.port,
      cert,
      "/health"
    )
  ).toEqual({ statusCode: 204 });
  expect(JSON.parse(await readFile(seenPath, "utf8"))).toMatchObject({
    sni: "fixture.invalid",
    request: `GET /health HTTP/1.1\r\nHost: fixture.invalid:${address.port}\r\nConnection: close\r\n\r\n`,
    remote: "127.0.0.1",
  });
  await rm(seenPath);
  let peerPort = 0;
  const proof = verifyNativeHttpsHostname(
    "fixture.invalid",
    address.port,
    cert,
    "/health",
    async (port) => {
      peerPort = port;
      await Bun.sleep(30);
      expect(await Bun.file(seenPath).exists()).toBe(false);
    }
  );
  expect(await proof).toEqual({ statusCode: 204 });
  expect(peerPort).toBeGreaterThan(0);
  expect(JSON.parse(await readFile(seenPath, "utf8")).remote_port).toBe(
    peerPort
  );
  await rm(seenPath);
  await expect(
    verifyNativeHttpsHostname(
      "fixture.invalid",
      address.port,
      cert,
      "/health",
      async () => {
        throw new Error("untrusted peer detail");
      }
    )
  ).rejects.toThrow("Native HTTPS verification failed");
  expect(await Bun.file(seenPath).exists()).toBe(false);
  await expect(
    verifyNativeHttpsHostname("wrong.invalid", address.port, cert, "/health")
  ).rejects.toThrow("Native HTTPS verification failed");
  const foreignCa = join(root, "foreign.pem");
  await writeFile(foreignCa, CURRENT_CA_PEM);
  await expect(
    verifyNativeHttpsHostname(
      "fixture.invalid",
      address.port,
      foreignCa,
      "/health"
    )
  ).rejects.toThrow("Native HTTPS verification failed");
  await writeFile(
    responsePath,
    "HTTP/1.1 307 Temporary Redirect\r\nLocation: https://canonical.invalid/health\r\nContent-Length: 0\r\n\r\n"
  );
  expect(
    await verifyNativeHttpsHostname(
      "fixture.invalid",
      address.port,
      cert,
      "/health"
    )
  ).toEqual({ statusCode: 307, location: "https://canonical.invalid/health" });
  for (const invalid of [
    "HTTP/1.1 100 Continue\r\n\r\n",
    "malformed\r\n",
    `HTTP/1.1 200 ${"x".repeat(2048)}\r\n`,
    "HTTP/1.1 200 OK",
  ]) {
    await writeFile(responsePath, invalid);
    await expect(
      verifyNativeHttpsHostname(
        "fixture.invalid",
        address.port,
        cert,
        "/health"
      )
    ).rejects.toThrow("Native HTTPS verification failed");
  }
});

test("HTTPS probe paths match native path bounds and reject request injection", () => {
  for (const path of [
    "/health",
    "/api/health?ready=1",
    `/${"a".repeat(511)}`,
  ]) {
    expect(isNativeHttpsProbePath(path)).toBe(true);
  }
  for (const path of [
    undefined,
    "",
    "health",
    "/bad path",
    "/bad#fragment",
    "/bad\r\nHost: evil",
    "/é",
    `/${"a".repeat(512)}`,
  ]) {
    expect(isNativeHttpsProbePath(path)).toBe(false);
  }
});

test("HTTPS header parsing refuses duplicate, folded and oversized fields", () => {
  for (const value of [
    "HTTP/1.1 307 Redirect\r\nLocation: /a\r\nlocation: /b\r\n\r\n",
    "HTTP/1.1 200 OK\r\n folded\r\n\r\n",
    `HTTP/1.1 200 OK\r\nX: ${"x".repeat(8192)}\r\n\r\n`,
    "HTTP/1.1 200 OK\r\nX: bad\0value\r\n\r\n",
  ]) {
    expect(() => parseNativeHttpsHeaders(value)).toThrow();
  }
});

test("HTTPS headers permit unrelated duplicates but keep Location unambiguous", () => {
  expect(
    parseNativeHttpsHeaders(
      "HTTP/1.1 200 OK\r\nSet-Cookie: first=synthetic\r\nSet-Cookie: second=synthetic\r\n\r\n"
    )
  ).toEqual({ statusCode: 200 });
  expect(() =>
    parseNativeHttpsHeaders(
      "HTTP/1.1 307 Redirect\r\nLocation: /health\r\nLOCATION: /health\r\n\r\n"
    )
  ).toThrow();
});

test("initial authority observation retains a safe startup stage without retrying the request", async () => {
  const f = await fixture();
  let calls = 0;
  const invoke = async () => {
    calls++;
    throw new NativeRuntimeRequestError({
      message: "private native stderr",
      nativeCode: "provider_busy",
    });
  };
  let failure: unknown;
  try {
    await startNativeProjectHttps({
      ...f.opts,
      dependencies: { ...f.opts.dependencies, invoke },
    });
  } catch (error) {
    failure = error;
  }
  expect(String(failure)).toContain("authority-observation: provider_busy");
  expect(String(failure)).not.toContain("private");
  expect(calls).toBe(1);
  expect(f.children).toHaveLength(0);
  await expect(
    access(join(f.root, "native-https/owner.lock"))
  ).rejects.toThrow();
});

test.each([
  [
    JSON.stringify({ code: "provider_busy", message: "secret-CANARY" }),
    2,
    "provider_busy",
  ],
  [
    JSON.stringify({ code: "authority_ownership", message: "secret-CANARY" }),
    2,
    "authority_ownership",
  ],
  ["secret-CANARY", 2, null],
  ["x".repeat(9000), 2, null],
  [JSON.stringify({ code: "secret_canary" }), 2, null],
  ["", 7, null],
  [JSON.stringify({ code: "provider_busy" }), 0, null],
] as const)("authority child output is classified without exposing values (%#)", async (output, code, expected) => {
  const child = spawnNativeHttpsChild({
    argv: [
      process.execPath,
      "-e",
      `process.stderr.write(${JSON.stringify(output)}); process.exit(${code});`,
    ],
    env: { PATH: "/usr/bin:/bin" },
    pipe: true,
    nativeDiagnostics: true,
  });
  try {
    expect(await child.exited).toBe(code);
    const failure = await child.failure;
    const classified = new NativeHttpsStartupError("authority-ready", failure);
    expect(classified.diagnostic.nativeCode).toBe(expected);
    expect(classified.message).not.toContain("CANARY");
    if (code === 0) {
      expect(failure).toBeUndefined();
    }
  } finally {
    child.endInput();
    child.kill("SIGKILL");
    await child.exited;
  }
});

test("authority child classification bounds an inherited stderr stream after exit", async () => {
  let canceled = false;
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          '{"code":"provider_busy","message":"secret-CANARY"}'
        )
      );
    },
    cancel() {
      canceled = true;
    },
  });
  const start = Date.now();
  const failure = await captureNativeHttpsChildFailure({
    exited: Promise.resolve(2),
    stderr,
  });
  expect(Date.now() - start).toBeLessThan(2000);
  expect(canceled).toBe(true);
  expect(failure?.nativeCode).toBe("provider_busy");
  expect(failure?.message).not.toContain("CANARY");
});

test("authority exits carry the typed failure through readiness without starting Caddy", async () => {
  const f = await fixture();
  const spawn = f.opts.dependencies.spawn!;
  await expect(
    startNativeProjectHttps({
      ...f.opts,
      dependencies: {
        ...f.opts.dependencies,
        spawn: (input) => {
          const child = spawn(input);
          if (input.pipe) {
            expect(input.nativeDiagnostics).toBe(true);
            f.children[0]?.finish(2);
            return {
              ...child,
              failure: Bun.sleep(100).then(
                () =>
                  new NativeRuntimeRequestError({
                    message: "secret-CANARY",
                    nativeCode: "provider_busy",
                  })
              ),
            };
          }
          return child;
        },
      },
    })
  ).rejects.toThrow("authority-ready: provider_busy");
  expect(f.children).toHaveLength(1);
});

test("permission-port failure is distinct from authority readiness", async () => {
  const f = await fixture();
  await expect(
    startNativeProjectHttps({
      ...f.opts,
      dependencies: {
        ...f.opts.dependencies,
        permissionPort: async () => {
          throw new Error("secret-CANARY");
        },
      },
    })
  ).rejects.toThrow("permission-port");
  expect(f.children).toHaveLength(1);
});
