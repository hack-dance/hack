import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connect as connectTls,
  createSecureContext,
  createServer as createTlsServer,
} from "node:tls";
import { LEGACY_SCHEMAS_HOST } from "../src/constants.ts";
import {
  inspectProxyLoopback,
  openProxyLoopbackWarning,
  probeProxyLoopback,
  resolveProxyLoopbackAddresses,
} from "../src/lib/proxy-loopback.ts";
import { CURRENT_CA_PEM } from "./helpers/ca-certificates.ts";

const loadCa = () =>
  Promise.resolve({
    state: "current" as const,
    message: "verified",
    currentPem: CURRENT_CA_PEM,
    loopbackPorts: { 80: ["0.0.0.0", "::"], 443: ["0.0.0.0", "::"] },
  });
const noListeners = () => Promise.resolve([]);

test("IPv4 timeout and foreign IPv6 TLS warn despite healthy port 80; visible listener is named without privilege", async () => {
  const calls: string[] = [];
  const report = await inspectProxyLoopback({
    loadCa,
    probe: async ({ address, port, caPem }) => {
      calls.push(`${address}/${port}`);
      expect(caPem).toBe(CURRENT_CA_PEM);
      return port === 80
        ? "ok"
        : address === "127.0.0.1"
          ? "timeout"
          : "tls-error";
    },
    listListeners: async () => [
      { address: "*", port: 443, process: "sample-vpn", pid: 123 },
      { address: "127.0.0.1", port: 80, process: "http-listener", pid: 124 },
    ],
  });
  expect(calls.sort()).toEqual([
    "127.0.0.1/443",
    "127.0.0.1/80",
    "::1/443",
    "::1/80",
  ]);
  expect(report.status).toBe("warn");
  expect(report.message).toContain(
    "port 443 on loopback is not reaching the Hack proxy"
  );
  expect(report.message).toContain("127.0.0.1:443: timeout");
  expect(report.message).toContain(
    "[::1]:443: certificate or TLS verification failed"
  );
  expect(report.message).toContain("sample-vpn");
  expect(report.message).not.toContain("http-listener");
  expect(report.message).toContain(
    "Affected hostnames: those resolving to these loopback addresses"
  );
  expect(report.message).toContain("container runtime's own HTTPS setting");
  expect(report.message).not.toContain("sudo");
  expect(report.message).not.toContain("--fix");
});

test("neither address family can mask the other, and port 80 has a separate result", async () => {
  for (const failure of ["127.0.0.1/443", "::1/443", "127.0.0.1/80"]) {
    const report = await inspectProxyLoopback({
      loadCa,
      probe: async ({ address, port }) =>
        `${address}/${port}` === failure ? "unreachable" : "ok",
      listListeners: async () => null,
    });
    expect(report.status).toBe("warn");
    expect(report.message).toContain(
      `port ${failure.split("/")[1]} on loopback is not reaching the Hack proxy`
    );
  }
});

test("a running root still authenticates when its exported copy is stale or missing", async () => {
  for (const state of ["current", "stale", "missing"] as const) {
    const report = await inspectProxyLoopback({
      loadCa: async () => ({
        state,
        message: "runtime root verified",
        currentPem: CURRENT_CA_PEM,
        loopbackPorts: { 80: ["0.0.0.0", "::"], 443: ["0.0.0.0", "::"] },
      }),
      probe: async () => "ok",
      listListeners: async () => {
        throw new Error("healthy probes do not list listeners");
      },
    });
    expect(report.status).toBe("ok");
  }
});

test("missing running-CA evidence warns without probing unrelated host listeners", async () => {
  const report = await inspectProxyLoopback({
    loadCa: async () => ({ state: "unavailable", message: "unavailable" }),
    probe: async () => {
      throw new Error("no runtime witness");
    },
    listListeners: async () => {
      throw new Error("no failed probe");
    },
  });
  expect(report.verified).toBe(false);
  expect(report.status).toBe("warn");
  expect(report.message).toContain("internal CA is unavailable");
});

test("doctor and open probe only the running proxy's published loopback bindings", async () => {
  for (const [bindings, expected] of [
    [["127.0.0.1"], ["127.0.0.1"]],
    [["::1"], ["::1"]],
    [["0.0.0.0"], ["127.0.0.1"]],
    [["::"], ["::1"]],
    [
      ["0.0.0.0", "::"],
      ["127.0.0.1", "::1"],
    ],
    [[], []],
  ] as const) {
    const calls: string[] = [];
    const inspect: typeof inspectProxyLoopback = (opts) =>
      inspectProxyLoopback({
        ...opts,
        loadCa: async () => ({
          ...(await loadCa()),
          loopbackPorts: { 80: bindings, 443: bindings },
        }),
        probe: async ({ address, port }) => {
          calls.push(`${address}/${port}`);
          return "ok";
        },
      });
    const report = await inspect();
    expect(report.status).toBe("ok");
    expect(calls.sort()).toEqual(
      expected
        .flatMap((address) => [80, 443].map((port) => `${address}/${port}`))
        .sort()
    );
    calls.length = 0;
    expect(
      await openProxyLoopbackWarning({
        url: "https://app.example.test",
        lookup: async () => ["127.0.0.1", "::1"],
        inspect,
      })
    ).toBeNull();
    expect(calls).toEqual(expected.map((address) => `${address}/443`));
    if (!expected.length) {
      expect(report.message).toContain("Loopback check skipped");
    }
  }
});

test("the two published ports can bind different families, and missing publication data stays unknown", async () => {
  const calls: string[] = [];
  const report = await inspectProxyLoopback({
    loadCa: async () => ({
      ...(await loadCa()),
      loopbackPorts: { 80: ["127.0.0.1"], 443: ["::1"] },
    }),
    probe: async ({ address, port }) => {
      calls.push(`${address}/${port}`);
      return "ok";
    },
  });
  expect(report.status).toBe("ok");
  expect(calls).toEqual(["127.0.0.1/80", "::1/443"]);
  expect(
    await openProxyLoopbackWarning({
      url: "https://[::1]",
      inspect: (opts) =>
        inspectProxyLoopback({
          ...opts,
          loadCa: async () => ({
            ...(await loadCa()),
            loopbackPorts: { 80: ["127.0.0.1"], 443: ["127.0.0.1"] },
          }),
          probe: async () => {
            throw new Error("IPv6 is not published");
          },
        }),
    })
  ).toBeNull();
  const unknown = await inspectProxyLoopback({
    loadCa: async () => ({
      state: "current",
      message: "verified",
      currentPem: CURRENT_CA_PEM,
    }),
    probe: async () => {
      throw new Error("no publication evidence");
    },
  });
  expect(unknown.status).toBe("warn");
  expect(unknown.verified).toBe(false);
  expect(unknown.message).toContain("port bindings are unavailable");
});

test("open checks only the selected URL's resolved loopback family and returns the same diagnosis", async () => {
  const addresses: string[] = [];
  const warning = await openProxyLoopbackWarning({
    url: "https://app.example.test",
    lookup: async () => ["127.0.0.1", "127.0.0.1"],
    inspect: (opts) => {
      expect(opts?.addresses).toEqual(["127.0.0.1"]);
      expect(opts?.ports).toEqual([443]);
      return inspectProxyLoopback({
        ...opts,
        loadCa,
        probe: async ({ address }) => {
          addresses.push(address);
          return "timeout";
        },
        listListeners: noListeners,
      });
    },
  });
  const doctor = await inspectProxyLoopback({
    addresses: ["127.0.0.1"],
    ports: [443],
    loadCa,
    probe: async () => "timeout",
    listListeners: noListeners,
  });
  expect(warning).toBe(doctor.message);
  expect(addresses).toEqual(["127.0.0.1"]);
});

test("open preserves direct-container routes, custom ports, and non-HTTP targets", async () => {
  for (const url of [
    "https://app.example.test",
    "https://127.0.0.1:8443",
    "file:///fixture",
    "mailto:fixture@example.test",
  ]) {
    expect(
      await openProxyLoopbackWarning({
        url,
        lookup: async () => ["172.30.0.2"],
        inspect: async () => {
          throw new Error("not a loopback proxy path");
        },
      })
    ).toBeNull();
  }
});

test("doctor warns for one failed family while open preserves healthy family and container DNS fallback", async () => {
  for (const failing of ["127.0.0.1", "::1"]) {
    const inspect: typeof inspectProxyLoopback = (opts) =>
      inspectProxyLoopback({
        ...opts,
        loadCa,
        probe: async ({ address }) => (address === failing ? "timeout" : "ok"),
        listListeners: noListeners,
      });
    expect((await inspect()).status).toBe("warn");
    expect(
      await openProxyLoopbackWarning({
        url: "https://app.example.test",
        lookup: async () => ["127.0.0.1", "::1"],
        inspect,
      })
    ).toBeNull();
  }
  expect(
    await openProxyLoopbackWarning({
      url: "https://app.example.test",
      lookup: async () => ["127.0.0.1", "172.30.0.2"],
      inspect: async () => {
        throw new Error(
          "direct-container alternative must preserve browser fallback"
        );
      },
    })
  ).toBeNull();
  expect(
    await openProxyLoopbackWarning({
      url: "https://app.example.test",
      lookup: async () => ["127.0.0.1", "::1"],
      inspect: (opts) =>
        inspectProxyLoopback({
          ...opts,
          loadCa,
          probe: async () => "timeout",
          listListeners: noListeners,
        }),
    })
  ).toContain("port 443 on loopback");
});

test("open recognizes loopback literals without DNS, including mapped IPv4", async () => {
  for (const url of [
    "https://127.0.0.2",
    "https://[::1]",
    "https://[::ffff:127.0.0.1]",
  ]) {
    const warning = await openProxyLoopbackWarning({
      url,
      lookup: async () => {
        throw new Error("literal needs no DNS");
      },
      inspect: (opts) =>
        inspectProxyLoopback({
          ...opts,
          loadCa,
          probe: async () => "timeout",
          listListeners: noListeners,
        }),
    });
    expect(warning).toContain("port 443 on loopback");
  }
});

test("open does not turn unavailable CA evidence into a foreign-listener refusal", async () => {
  expect(
    await openProxyLoopbackWarning({
      url: "https://127.0.0.1",
      inspect: (opts) =>
        inspectProxyLoopback({
          ...opts,
          loadCa: async () => ({
            state: "unavailable",
            message: "unavailable",
          }),
        }),
    })
  ).toBeNull();
});

test("system resolver boundary preserves both Mac families and bounds output and child lifetime", async () => {
  for (const platform of ["darwin", "linux"] as const) {
    const result = await resolveProxyLoopbackAddresses({
      hostname: "app.example.test",
      platform,
      execute: async (command, options) => {
        expect(command).toEqual(
          platform === "darwin"
            ? [
                "/usr/bin/dscacheutil",
                "-q",
                "host",
                "-a",
                "name",
                "app.example.test",
              ]
            : ["getent", "ahosts", "app.example.test"]
        );
        expect(options).toEqual({
          timeoutMs: 500,
          stdin: "ignore",
          maxStdoutBytes: 16_384,
        });
        return {
          exitCode: 0,
          stdout:
            platform === "darwin"
              ? "name: app.example.test\nip_address: 127.0.0.1\nipv6_address: ::1\n"
              : "127.0.0.1 STREAM app.example.test\n127.0.0.1 DGRAM\n::1 STREAM\n",
          stderr: "",
        };
      },
    });
    expect(result).toEqual(["127.0.0.1", "::1"]);
  }
  for (const exitCode of [1, 124]) {
    expect(
      await resolveProxyLoopbackAddresses({
        hostname: "app.example.test",
        execute: async () => ({
          exitCode,
          stdout: "127.0.0.1 STREAM",
          stderr: "untrusted detail",
        }),
      })
    ).toEqual([]);
  }
  expect(
    await resolveProxyLoopbackAddresses({
      hostname: "app.example.test",
      execute: async () => {
        throw new Error("missing resolver");
      },
    })
  ).toEqual([]);
});

test("an oversized DNS answer remains unknown instead of hiding a fallback behind truncation", async () => {
  const stdout = [
    ...Array.from({ length: 16 }, (_, i) => `127.0.0.${i + 1} STREAM`),
    "172.30.0.2 STREAM",
    "",
  ].join("\n");
  expect(
    await resolveProxyLoopbackAddresses({
      hostname: "app.example.test",
      platform: "linux",
      execute: async () => ({ exitCode: 0, stdout, stderr: "" }),
    })
  ).toEqual([]);
});

let root: string;
let key: string;
let certificate: string;
let wrongHostname: string;
let rootPem: string;
const sockets = new Set<Socket>();
const servers: ReturnType<typeof createTcpServer>[] = [];

async function openssl(args: readonly string[]): Promise<void> {
  const child = Bun.spawn(["openssl", ...args], {
    cwd: root,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [, exit] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) {
    throw new Error("Synthetic TLS fixture generation failed");
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "proxy-loopback-tls-"));
  await openssl([
    "req",
    "-config",
    "/dev/null",
    "-sha256",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "1",
    "-subj",
    "/CN=Fixture Root",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
    "-addext",
    "subjectKeyIdentifier=hash",
    "-addext",
    "authorityKeyIdentifier=keyid:always",
  ]);
  await openssl([
    "req",
    "-config",
    "/dev/null",
    "-sha256",
    "-new",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    "leaf.key",
    "-out",
    "leaf.csr",
    "-subj",
    "/CN=Fixture Leaf",
  ]);
  for (const [name, host] of [
    ["leaf", LEGACY_SCHEMAS_HOST],
    ["wrong", "foreign.example.test"],
  ]) {
    await Bun.write(
      join(root, `${name}.ext`),
      `subjectAltName=DNS:${host}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n`
    );
    await openssl([
      "x509",
      "-sha256",
      "-req",
      "-in",
      "leaf.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-out",
      `${name}.pem`,
      "-days",
      "1",
      "-extfile",
      `${name}.ext`,
    ]);
  }
  [key, certificate, wrongHostname, rootPem] = await Promise.all([
    Bun.file(join(root, "leaf.key")).text(),
    Bun.file(join(root, "leaf.pem")).text(),
    Bun.file(join(root, "wrong.pem")).text(),
    Bun.file(join(root, "ca.pem")).text(),
  ]);
});

afterEach(async () => {
  for (const socket of sockets) {
    socket.destroy();
  }
  sockets.clear();
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve()))
      )
  );
});

afterAll(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
  }
});

async function listen(
  server: ReturnType<typeof createTcpServer>,
  host: string
): Promise<number> {
  servers.push(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing fixture address");
  }
  return address.port;
}

/** Include only synthetic certificate metadata and TLS codes when a CI platform fails. */
async function explainTlsFixture(host: string, port: number): Promise<string> {
  const ca = new X509Certificate(rootPem);
  const leaf = new X509Certificate(certificate);
  const tls = await new Promise((resolve) => {
    let settled = false;
    const socket = connectTls({
      host,
      port,
      servername: LEGACY_SCHEMAS_HOST,
      ca: rootPem,
      rejectUnauthorized: true,
    });
    const timer = setTimeout(() => done({ event: "timeout" }), 1000);
    function done(value: unknown) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    }
    socket.once("secureConnect", () =>
      done({
        event: "secureConnect",
        authorized: socket.authorized,
        authorizationError: socket.authorizationError,
      })
    );
    socket.once("error", (error: NodeJS.ErrnoException) =>
      done({ event: "error", code: error.code })
    );
  });
  return JSON.stringify({
    platform: process.platform,
    bun: Bun.version,
    host,
    now: new Date().toISOString(),
    rootCa: ca.ca,
    signatureValid: leaf.verify(ca.publicKey),
    leafValidFrom: leaf.validFrom,
    leafValidTo: leaf.validTo,
    tls,
  });
}

test("real TLS accepts only the pinned root and own hostname, on IPv4 and IPv6", async () => {
  for (const host of ["127.0.0.1", "::1"]) {
    const names: string[] = [];
    const context = createSecureContext({ key, cert: certificate });
    const server = createTlsServer({
      key,
      cert: certificate,
      SNICallback: (name, callback) => {
        names.push(name);
        callback(null, context);
      },
    });
    const port = await listen(server, host);
    const result = await probeProxyLoopback({
      address: host,
      port,
      protocol: "https",
      caPem: rootPem,
    });
    expect(
      result,
      result === "ok" ? host : await explainTlsFixture(host, port)
    ).toBe("ok");
    expect(
      await probeProxyLoopback({
        address: host,
        port,
        protocol: "https",
        caPem: CURRENT_CA_PEM,
      })
    ).toBe("tls-error");
    expect(names).toContain(LEGACY_SCHEMAS_HOST);
  }
});

test("real TLS rejects a certificate signed by the right CA for a different hostname", async () => {
  const port = await listen(
    createTlsServer({ key, cert: wrongHostname }),
    "127.0.0.1"
  );
  expect(
    await probeProxyLoopback({
      address: "127.0.0.1",
      port,
      protocol: "https",
      caPem: rootPem,
    })
  ).toBe("tls-error");
});

test("a silent TCP listener passes HTTP reachability but HTTPS times out and closes its socket", async () => {
  const port = await listen(createTcpServer(), "127.0.0.1");
  expect(
    await probeProxyLoopback({
      address: "127.0.0.1",
      port,
      protocol: "http",
      caPem: rootPem,
    })
  ).toBe("ok");
  const started = performance.now();
  expect(
    await probeProxyLoopback({
      address: "127.0.0.1",
      port,
      protocol: "https",
      caPem: rootPem,
      timeoutMs: 50,
    })
  ).toBe("timeout");
  expect(performance.now() - started).toBeLessThan(1000);
});
