import { expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { connect as connectTls } from "node:tls";
import {
  type HttpsChild,
  inspectActiveNativeHttpsOwner,
  spawnNativeHttpsChild,
  startNativeProjectHttps,
} from "../src/backends/native-project-https.ts";
import { invokeNativeRuntime } from "../src/backends/native-runtime-client.ts";
import { checkMacCaTrust } from "../src/lib/mac-ca-trust.ts";
import { inspectNativeCaTrust } from "../src/lib/native-ca-doctor.ts";

/** Opt in with HACK_NATIVE_CA_LIVE=1 and explicit Caddy binary/SHA and native binary paths. */
const liveTest = test.skipIf(
  process.platform !== "darwin" || process.env.HACK_NATIVE_CA_LIVE !== "1"
);
const SHA256 = /^[a-f0-9]{64}$/;
const HOSTNAME = "rotation-fixture.hack.local";

async function unusedHighPort(): Promise<number> {
  const server = createServer();
  try {
    return await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string" || address.port < 10_000) {
          reject(new Error("Could not select a high loopback port"));
          return;
        }
        resolve(address.port);
      });
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function tlsHandshake(port: number, ca: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connectTls({
      host: "127.0.0.1",
      port,
      servername: HOSTNAME,
      ca,
      rejectUnauthorized: true,
    });
    socket.setTimeout(5000, () =>
      socket.destroy(new Error("TLS handshake timed out"))
    );
    socket.once("secureConnect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

/** Replace only the VM-backed hostname authority; Caddy and listener inspection stay real. */
function fixtureAuthority(home: string) {
  const socketPath = join(home, "route.sock");
  const identityPath = `${socketPath}.identity`;
  let server: Server | undefined;
  let ready = false;
  let resolveExit: ((code: number) => void) | undefined;
  let closing: Promise<void> | undefined;
  const shutdown = () =>
    (closing ??= (async () => {
      ready = false;
      if (server?.listening) {
        await new Promise<void>((resolve) => server?.close(() => resolve()));
      }
      await rm(socketPath, { force: true });
      await rm(identityPath, { force: true });
      server = undefined;
      resolveExit?.(0);
    })());
  const invoke: typeof invokeNativeRuntime = async (request) => {
    switch (request.args[1]) {
      case "inspect-host-listener":
        return await invokeNativeRuntime(request);
      case "managed-hostname-authority": {
        if (!ready) {
          return { socket: socketPath, authority: { present: false } };
        }
        const bytes = await readFile(identityPath);
        return {
          socket: socketPath,
          authority: {
            present: true,
            process_present: true,
            socket_present: true,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        };
      }
      case "stop-hostname-authority":
        await shutdown();
        return { stopped: true, process_exit_observed: true };
      default:
        throw new Error(
          "Unexpected native authority operation in live Caddy fixture"
        );
    }
  };
  const spawn = (
    input: Parameters<typeof spawnNativeHttpsChild>[0]
  ): HttpsChild => {
    if (!input.pipe) {
      return spawnNativeHttpsChild(input);
    }
    if (server) {
      throw new Error("Fixture authority already owns its socket");
    }
    closing = undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    server = createServer((socket) => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
    });
    server.listen(socketPath, () => {
      void (async () => {
        await chmod(socketPath, 0o600);
        await writeFile(
          identityPath,
          JSON.stringify({ process: { pid: process.pid } }),
          { mode: 0o600 }
        );
        ready = true;
      })().catch(() => {
        void shutdown();
      });
    });
    return {
      pid: process.pid,
      exited,
      kill: () => {
        void shutdown();
      },
      endInput: () => {
        void shutdown();
      },
    };
  };
  return { invoke, spawn };
}

liveTest(
  "live native Caddy root rotation rejects an old same-subject root",
  async () => {
    const selectedCaddy = process.env.HACK_NATIVE_CA_LIVE_CADDY_BINARY;
    const selectedPin = process.env.HACK_NATIVE_CA_LIVE_CADDY_SHA256;
    const selectedRuntime = process.env.HACK_NATIVE_CA_LIVE_RUNTIME_BINARY;
    if (
      !(
        selectedCaddy &&
        selectedPin &&
        selectedRuntime &&
        SHA256.test(selectedPin)
      )
    ) {
      throw new Error(
        "Live fixture requires explicit Caddy binary, SHA256 pin and native runtime binary"
      );
    }
    const caddyBinary = await realpath(selectedCaddy);
    expect(caddyBinary).toBe(selectedCaddy);
    expect(
      createHash("sha256")
        .update(await readFile(caddyBinary))
        .digest("hex")
    ).toBe(selectedPin);
    const runtimeBinary = await realpath(selectedRuntime);
    expect(runtimeBinary).toBe(selectedRuntime);

    const home = await mkdtemp(join(await realpath("/tmp"), "hk-ca-live-"));
    await chmod(home, 0o700);
    const runtime = { binary: runtimeBinary, home };
    const httpsPort = await unusedHighPort();
    const authority = fixtureAuthority(home);
    const options = {
      runtime,
      caddyBinary,
      caddySha256: selectedPin,
      httpsPort,
      dependencies: authority,
    };
    let first: Awaited<ReturnType<typeof startNativeProjectHttps>> | undefined;
    let second: Awaited<ReturnType<typeof startNativeProjectHttps>> | undefined;
    try {
      const keychainReads: string[][] = [];
      const withInstalledRoot = (pem: string) => ({
        trust: (input: Parameters<typeof checkMacCaTrust>[0]) =>
          checkMacCaTrust({
            ...input,
            exec: async (command) => {
              keychainReads.push([...command]);
              return {
                exitCode: 0,
                stdout: command[1] === "find-certificate" ? pem : "",
                stderr: "",
              };
            },
          }),
      });
      first = await startNativeProjectHttps(options);
      const originalOwner = await inspectActiveNativeHttpsOwner({
        runtime,
        invoke: authority.invoke,
      });
      const oldPem = await readFile(originalOwner.caPath, "utf8");
      const oldRoot = new X509Certificate(oldPem);
      expect(originalOwner.caSha256).toBe(
        createHash("sha256").update(oldRoot.raw).digest("hex")
      );
      await tlsHandshake(httpsPort, oldPem);
      const originalDiagnosis = await inspectNativeCaTrust({
        runtime,
        dependencies: {
          ...withInstalledRoot(oldPem),
          inspect: (input) =>
            inspectActiveNativeHttpsOwner({
              ...input,
              invoke: authority.invoke,
            }),
        },
      });
      expect(originalDiagnosis.trust.trusted).toBe(true);
      expect(keychainReads.map((command) => command[1])).toEqual([
        "find-certificate",
        "verify-cert",
      ]);
      await first.close();
      first = undefined;

      await rename(
        join(home, "native-https/data"),
        join(home, "retired-native-https-data")
      );
      second = await startNativeProjectHttps(options);
      const currentOwner = await inspectActiveNativeHttpsOwner({
        runtime,
        invoke: authority.invoke,
      });
      const currentPem = await readFile(currentOwner.caPath, "utf8");
      const currentRoot = new X509Certificate(currentPem);
      expect(currentRoot.subject).toBe(oldRoot.subject);
      expect(currentRoot.raw).not.toEqual(oldRoot.raw);
      expect(currentOwner.caSha256).not.toBe(originalOwner.caSha256);
      await tlsHandshake(httpsPort, currentPem);
      await expect(tlsHandshake(httpsPort, oldPem)).rejects.toHaveProperty(
        "code",
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"
      );

      const diagnosis = await inspectNativeCaTrust({
        runtime,
        dependencies: {
          ...withInstalledRoot(oldPem),
          inspect: (input) =>
            inspectActiveNativeHttpsOwner({
              ...input,
              invoke: authority.invoke,
            }),
        },
      });
      expect(diagnosis.owner.caSha256).toBe(currentOwner.caSha256);
      expect(diagnosis.trust.installable).toBe(true);
      expect(diagnosis.trust.trusted).toBe(false);
      expect(diagnosis.trust.issue).toContain(
        "missing the current Caddy Local CA"
      );
      expect(keychainReads.map((command) => command[1])).toEqual([
        "find-certificate",
        "verify-cert",
        "find-certificate",
      ]);
    } finally {
      try {
        await second?.close();
        await first?.close();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  },
  60_000
);
