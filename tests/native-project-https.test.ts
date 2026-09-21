import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import {
  type HttpsChild,
  isNativeHttpsProbePath,
  nativeHttpsVerificationError,
  spawnNativeHttpsChild,
  startNativeProjectHttps,
  verifyNativeHttpsHostname,
} from "../src/backends/native-project-https.ts";
import { CURRENT_CA_PEM } from "./helpers/ca-certificates.ts";

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
  const events: string[] = [];
  const deps: NonNullable<
    Parameters<typeof startNativeProjectHttps>[0]["dependencies"]
  > = {
    checkPort: async () => {},
    permissionPort: async () => 18_443,
    adminReady: async () => true,
    invoke: async (request) => {
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
  await running.close();
  await running.close();
  expect(f.events).toEqual(["1:SIGTERM", "0:cooperative-stop", "0:EOF"]);
  expect(await readFile(running.caPath, "utf8")).toBe(CURRENT_CA_PEM);
  await expect(
    access(join(f.root, "native-https/owner.lock"))
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
   seen.update(request=data.decode(),remote=remote[0])
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
  expect(JSON.parse(await readFile(seenPath, "utf8"))).toEqual({
    sni: "fixture.invalid",
    request: `GET /health HTTP/1.1\r\nHost: fixture.invalid:${address.port}\r\nConnection: close\r\n\r\n`,
    remote: "127.0.0.1",
  });
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
