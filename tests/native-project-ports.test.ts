import { expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import {
  checkNativeLoopbackPorts,
  loopbackPortAccepts,
  nativeBridgeSocketCount,
  nativePortPublicationCount,
  reviewedNativeLoopbackPorts,
} from "../src/backends/native-project-ports.ts";
import { HackCliError } from "../src/lib/cli-result.ts";

function listen(host: string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no address"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("bridge sizing counts every declared port entry, including inactive profiles", () => {
  const specs = {
    web: { image: "web", ports: ["127.0.0.1:8787:8787", "8080:80"] },
    search: { image: "search", profiles: ["search"], ports: [{ target: 1 }] },
    worker: { image: "worker" },
  };
  expect(nativePortPublicationCount(specs)).toBe(3);
  expect(nativeBridgeSocketCount({ routes: 2, ports: 3 })).toBe(5);
  expect(nativeBridgeSocketCount({ routes: 16, ports: 16 })).toBe(32);
  expect(() => nativeBridgeSocketCount({ routes: 17, ports: 16 })).toThrow(
    HackCliError
  );
});

test("only active reviewed IPv4 loopback TCP publications are preflighted", () => {
  const plan = {
    services: {
      web: {
        active: true,
        ports: [
          { protocol: "tcp", proposed_host_ip: "127.0.0.1", published: 8787 },
          { protocol: "tcp", proposed_host_ip: "127.0.0.1", published: 8080 },
          { protocol: "udp", proposed_host_ip: "127.0.0.1", published: 5353 },
          { protocol: "tcp", proposed_host_ip: "::1", published: 9000 },
          { protocol: "tcp", proposed_host_ip: "127.0.0.1", published: null },
        ],
      },
      search: {
        active: false,
        ports: [
          { protocol: "tcp", proposed_host_ip: "127.0.0.1", published: 8108 },
        ],
      },
    },
  };
  expect(reviewedNativeLoopbackPorts(plan)).toEqual([8080, 8787]);
  expect(reviewedNativeLoopbackPorts(undefined)).toEqual([]);
});

test("an occupied published port is a coded refusal that leaves the listener alone", async () => {
  const probed: number[] = [];
  const failure = await checkNativeLoopbackPorts([8080, 8787], (port) => {
    probed.push(port);
    return Promise.resolve(port === 8787);
  }).catch((error: unknown) => error);
  expect(probed).toEqual([8080, 8787]);
  expect(failure).toBeInstanceOf(HackCliError);
  expect(failure).toMatchObject({ code: "E_CONFIG_INVALID" });
  expect(String((failure as Error).message)).toContain("8787");
  await checkNativeLoopbackPorts([8080], () => Promise.resolve(false));
});

test("the loopback probe sees exact and wildcard listeners and a released port", async () => {
  const exact = await listen("127.0.0.1");
  expect(await loopbackPortAccepts(exact.port)).toBe(true);
  await close(exact.server);
  expect(await loopbackPortAccepts(exact.port)).toBe(false);
  const wildcard = await listen("0.0.0.0");
  expect(await loopbackPortAccepts(wildcard.port)).toBe(true);
  await close(wildcard.server);
});
