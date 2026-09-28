import { expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectNativeCaTrust,
  type NativeCaDoctorDependencies,
  repairNativeCaTrust,
} from "../src/lib/native-ca-doctor.ts";
import { CURRENT_CA_PEM, OLD_CA_PEM } from "./helpers/ca-certificates.ts";

const sha = (pem: string) =>
  createHash("sha256").update(new X509Certificate(pem).raw).digest("hex");

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "native-ca-doctor-"));
  const caPath = join(home, "root.crt");
  await writeFile(caPath, CURRENT_CA_PEM, { mode: 0o600 });
  const runtime = { binary: join(home, "native"), home };
  const owner = {
    caPath,
    caSha256: sha(CURRENT_CA_PEM),
    httpsPort: 18_443,
    listenerFingerprint: "a".repeat(64),
    caddyPid: 1000,
    caddyBinary: join(home, "caddy"),
    listenerIdentity: {
      pid: 1000,
      start_micros: 1_700_000_000_000_000,
      uid: process.getuid?.() ?? 0,
      executable: join(home, "caddy"),
      port: 18_443,
      fingerprint: "a".repeat(64),
    },
  };
  const calls: string[] = [];
  let selected = owner;
  let installed = false;
  const dependencies: NativeCaDoctorDependencies = {
    inspect: async () => {
      calls.push("inspect");
      return selected;
    },
    trust: async ({ certPath }) => {
      calls.push("trust");
      expect(sha(await readFile(certPath, "utf8"))).toBe(owner.caSha256);
      return {
        trusted: installed,
        installable: true,
        issue: installed ? undefined : "old same-name root only",
      };
    },
    verify: async (hostname, port, path, route, verifyPeer) => {
      calls.push("verify");
      expect([hostname, port, path, route]).toEqual([
        "app.hack.gy",
        18_443,
        caPath,
        "/",
      ]);
      await verifyPeer?.(42_000);
      return { statusCode: 200 };
    },
    verifyPeer: async ({ peerPort, owner: selectedOwner }) => {
      calls.push("peer");
      expect(peerPort).toBe(42_000);
      expect(selectedOwner.listenerFingerprint).toBe(owner.listenerFingerprint);
    },
    promptAllowed: () => true,
    confirm: async () => {
      calls.push("confirm");
      return true;
    },
    runCommand: async (cmd) => {
      calls.push(cmd[1] === "-v" ? "sudo-prompt" : "install");
      if (cmd[1] === "-n") {
        expect(sha(await readFile(cmd.at(-1) ?? "", "utf8"))).toBe(
          owner.caSha256
        );
        installed = true;
      }
      return 0;
    },
  };
  return {
    home,
    runtime,
    owner,
    calls,
    dependencies,
    select(next: typeof owner) {
      selected = next;
    },
    async cleanup() {
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("the old same-name root does not satisfy live native root trust", async () => {
  expect(new X509Certificate(OLD_CA_PEM).subject).toBe(
    new X509Certificate(CURRENT_CA_PEM).subject
  );
  expect(sha(OLD_CA_PEM)).not.toBe(sha(CURRENT_CA_PEM));
  const f = await fixture();
  try {
    const result = await inspectNativeCaTrust({
      runtime: f.runtime,
      hostname: "app.hack.gy",
      dependencies: f.dependencies,
    });
    expect(result.trust.trusted).toBe(false);
    expect(f.calls).toEqual(["inspect", "verify", "peer", "trust", "inspect"]);
  } finally {
    await f.cleanup();
  }
});

test("a rotated live owner during inspection refuses a current-trust claim", async () => {
  const f = await fixture();
  let count = 0;
  try {
    await expect(
      inspectNativeCaTrust({
        runtime: f.runtime,
        dependencies: {
          ...f.dependencies,
          inspect: async () => {
            count++;
            return {
              ...f.owner,
              caSha256: count === 1 ? f.owner.caSha256 : "b".repeat(64),
            };
          },
        },
      })
    ).rejects.toThrow("changed during trust verification");
  } finally {
    await f.cleanup();
  }
});

test("native trust repair never invokes sudo without an interactive confirmation", async () => {
  const f = await fixture();
  try {
    const result = await repairNativeCaTrust({
      runtime: f.runtime,
      hostname: "app.hack.gy",
      dependencies: { ...f.dependencies, promptAllowed: () => false },
    });
    expect(result).toBe("declined");
    expect(f.calls).not.toContain("confirm");
    expect(f.calls).not.toContain("sudo-prompt");
  } finally {
    await f.cleanup();
  }
});

test("native trust repair requires an exact reviewed HTTPS hostname", async () => {
  const f = await fixture();
  try {
    await expect(
      repairNativeCaTrust({
        runtime: f.runtime,
        dependencies: f.dependencies,
      })
    ).rejects.toThrow("requires a reviewed HTTPS hostname");
    expect(f.calls).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test("a TLS route without accepted Caddy peer proof cannot authorize trust repair", async () => {
  const f = await fixture();
  try {
    await expect(
      repairNativeCaTrust({
        runtime: f.runtime,
        hostname: "app.hack.gy",
        dependencies: {
          ...f.dependencies,
          verifyPeer: async () => {
            throw new Error("alternate listener");
          },
        },
      })
    ).rejects.toThrow("alternate listener");
    expect(f.calls).not.toContain("confirm");
    expect(f.calls).not.toContain("sudo-prompt");
  } finally {
    await f.cleanup();
  }
});

test("rotation after the sudo prompt prevents keychain installation", async () => {
  const f = await fixture();
  try {
    await expect(
      repairNativeCaTrust({
        runtime: f.runtime,
        hostname: "app.hack.gy",
        dependencies: {
          ...f.dependencies,
          runCommand: async (cmd) => {
            f.calls.push(cmd[1] === "-v" ? "sudo-prompt" : "install");
            if (cmd[1] === "-v") {
              f.select({ ...f.owner, listenerFingerprint: "b".repeat(64) });
            }
            return 0;
          },
        },
      })
    ).rejects.toThrow("changed during trust verification");
    expect(f.calls).not.toContain("install");
  } finally {
    await f.cleanup();
  }
});

test("confirmed native repair stages the exact root and checks trust afterward", async () => {
  const f = await fixture();
  try {
    expect(
      await repairNativeCaTrust({
        runtime: f.runtime,
        hostname: "app.hack.gy",
        dependencies: f.dependencies,
      })
    ).toBe("installed");
    expect(f.calls).toContain("sudo-prompt");
    expect(f.calls).toContain("install");
    expect(f.calls.slice(-2)).toEqual(["trust", "inspect"]);
  } finally {
    await f.cleanup();
  }
});
