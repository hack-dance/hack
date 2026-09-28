import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyNativeHttpsHostname } from "../src/backends/native-project-https.ts";
import { checkMacCaTrust } from "../src/lib/mac-ca-trust.ts";
import {
  inspectNativeCaTrust,
  type NativeCaDoctorDependencies,
  repairNativeCaTrust,
} from "../src/lib/native-ca-doctor.ts";

const HOSTNAME = "rotation-fixture.invalid";
const SUBJECT = "/CN=Caddy Local Authority Rotation Fixture";

function generateRoot(input: {
  readonly directory: string;
  readonly name: string;
}): {
  readonly certPath: string;
  readonly keyPath: string;
} {
  const certPath = join(input.directory, `${input.name}.crt`);
  const keyPath = join(input.directory, `${input.name}.key`);
  const result = spawnSync(
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
      SUBJECT,
      "-addext",
      `subjectAltName=DNS:${HOSTNAME}`,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore", timeout: 10_000 }
  );
  if (result.status !== 0) {
    throw new Error("Could not generate isolated CA rotation fixture");
  }
  return { certPath, keyPath };
}

async function startFrontend(input: {
  readonly scriptPath: string;
  readonly certPath: string;
  readonly keyPath: string;
  readonly port?: number;
}): Promise<{ readonly port: number; stop(): Promise<void> }> {
  const child = Bun.spawn(
    [
      "/usr/bin/python3",
      "-I",
      "-S",
      input.scriptPath,
      input.certPath,
      input.keyPath,
      String(input.port ?? 0),
    ],
    { stdout: "pipe", stderr: "ignore" }
  );
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill();
    }
    await child.exited;
  };
  const timeout = setTimeout(() => child.kill(), 5000);
  try {
    const reader = child.stdout.getReader();
    const announced = await reader.read();
    reader.releaseLock();
    const port = Number(new TextDecoder().decode(announced.value).trim());
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("Isolated TLS frontend did not bind a loopback port");
    }
    return { port, stop };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** The TLS peer is live; owner and System-keychain observations stay isolated injections. */
test("same-subject CA rotation rejects a stale live TLS and keychain trust claim", async () => {
  const home = await mkdtemp(join(tmpdir(), "native-ca-rotation-wire-"));
  let frontend: { readonly port: number; stop(): Promise<void> } | undefined;
  try {
    const scriptPath = join(home, "frontend.py");
    await writeFile(
      scriptPath,
      String.raw`import socket,ssl,sys
context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(sys.argv[1],sys.argv[2])
server=socket.socket()
server.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
server.bind(('127.0.0.1',int(sys.argv[3])))
server.listen(8)
print(server.getsockname()[1],flush=True)
while True:
 client,_=server.accept()
 try:
  with context.wrap_socket(client,server_side=True) as conn:
   conn.settimeout(3)
   request=b''
   while b'\r\n\r\n' not in request:
    part=conn.recv(4096)
    if not part: break
    request+=part
   if request: conn.sendall(b'HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n')
 except (OSError,ssl.SSLError): client.close()
`
    );
    const old = generateRoot({ directory: home, name: "old" });
    const current = generateRoot({ directory: home, name: "current" });
    const oldPem = await readFile(old.certPath, "utf8");
    const currentPem = await readFile(current.certPath, "utf8");
    const oldCert = new X509Certificate(oldPem);
    const currentCert = new X509Certificate(currentPem);
    expect(oldCert.subject).toBe(currentCert.subject);
    expect(oldCert.raw.equals(currentCert.raw)).toBe(false);
    expect(oldCert.ca).toBe(true);
    expect(currentCert.ca).toBe(true);

    frontend = await startFrontend({ ...old, scriptPath });
    const port = frontend.port;
    expect(
      await verifyNativeHttpsHostname(HOSTNAME, port, old.certPath, "/")
    ).toEqual({ statusCode: 204 });

    await frontend.stop();
    frontend = undefined;
    frontend = await startFrontend({ ...current, scriptPath, port });
    expect(frontend.port).toBe(port);
    const currentProbe = spawnSync(
      "/usr/bin/curl",
      [
        "--silent",
        "--show-error",
        "--noproxy",
        "*",
        "--cacert",
        current.certPath,
        "--resolve",
        `${HOSTNAME}:${port}:127.0.0.1`,
        "--output",
        "/dev/null",
        "--write-out",
        "%{http_code}",
        `https://${HOSTNAME}:${port}/`,
      ],
      { encoding: "utf8", timeout: 5000 }
    );
    expect(currentProbe.status).toBe(0);
    expect(currentProbe.stdout).toBe("204");
    await expect(
      verifyNativeHttpsHostname(HOSTNAME, port, old.certPath, "/")
    ).rejects.toThrow("Native HTTPS verification failed");

    const runtime = { binary: join(home, "unused-runtime"), home };
    const owner = {
      caPath: current.certPath,
      caSha256: createHash("sha256").update(currentCert.raw).digest("hex"),
      httpsPort: port,
      listenerFingerprint: "a".repeat(64),
      caddyPid: process.pid,
      caddyBinary: join(home, "fixture-frontend"),
      listenerIdentity: {
        pid: process.pid,
        start_micros: 1_700_000_000_000_000,
        uid: process.getuid?.() ?? 0,
        executable: join(home, "fixture-frontend"),
        port,
        fingerprint: "a".repeat(64),
      },
    };
    const keychainCalls: string[] = [];
    const dependencies: NativeCaDoctorDependencies = {
      inspect: async () => owner,
      trust: async ({ certPath }) =>
        await checkMacCaTrust({
          certPath,
          exec: async (cmd) => {
            keychainCalls.push(cmd[1] ?? "");
            if (cmd[1] !== "find-certificate") {
              throw new Error(
                "An old root cannot authorize trust verification"
              );
            }
            return { exitCode: 0, stdout: oldPem, stderr: "" };
          },
        }),
      verify: verifyNativeHttpsHostname,
      verifyPeer: async () => {},
      promptAllowed: () => false,
      confirm: async () => {
        throw new Error(
          "Noninteractive fixture must not confirm a trust repair"
        );
      },
      runCommand: async () => {
        throw new Error(
          "Fixture must not invoke sudo or the real System keychain"
        );
      },
    };
    const result = await inspectNativeCaTrust({
      runtime,
      hostname: HOSTNAME,
      dependencies,
    });
    expect(result.owner.caSha256).toBe(owner.caSha256);
    expect(result.trust).toMatchObject({ trusted: false, installable: true });
    expect(result.trust.issue).toContain("older root");
    expect(keychainCalls).toEqual(["find-certificate"]);
    expect(
      await repairNativeCaTrust({
        runtime,
        hostname: HOSTNAME,
        dependencies,
      })
    ).toBe("declined");
    expect(keychainCalls).toEqual(["find-certificate", "find-certificate"]);
  } finally {
    if (frontend) {
      await frontend.stop();
    }
    await rm(home, { recursive: true, force: true });
    expect(await Bun.file(home).exists()).toBe(false);
  }
});
