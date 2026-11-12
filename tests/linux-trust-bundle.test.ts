import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeLinuxHostTrustBundle } from "../src/commands/global.ts";
import { resolveHackHostTrustEnvScriptPath } from "../src/lib/local-ca.ts";
import { CURRENT_CA_PEM, OLD_CA_PEM } from "./helpers/ca-certificates.ts";
import { restoreEnv } from "./helpers/env.ts";

const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

async function setup(): Promise<{
  readonly dir: string;
  readonly certPath: string;
  readonly bundlePath: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "hack-linux-trust-"));
  tempDirs.add(dir);
  const certPath = join(dir, "caddy-local-authority.crt");
  await writeFile(
    certPath,
    "-----BEGIN CERTIFICATE-----\nLOCALCA\n-----END CERTIFICATE-----\n"
  );
  return { dir, certPath, bundlePath: join(dir, "bundle.pem") };
}

test("concatenates the first available system bundle with the local CA", async () => {
  const { dir, certPath, bundlePath } = await setup();
  const missing = join(dir, "missing.crt");
  const system = join(dir, "ca-certificates.crt");
  await writeFile(
    system,
    "-----BEGIN CERTIFICATE-----\nPUBLICROOT\n-----END CERTIFICATE-----\n"
  );

  const result = await writeLinuxHostTrustBundle({
    certPath,
    systemBundleCandidates: [missing, system],
    bundlePath,
  });

  expect(result).toBe(bundlePath);
  const text = await Bun.file(bundlePath).text();
  expect(text).toContain("PUBLICROOT");
  expect(text).toContain("LOCALCA");
  expect(text.indexOf("PUBLICROOT")).toBeLessThan(text.indexOf("LOCALCA"));
});

test("returns null (append-only fallback) when no system bundle exists", async () => {
  const { dir, certPath, bundlePath } = await setup();

  const result = await writeLinuxHostTrustBundle({
    certPath,
    systemBundleCandidates: [join(dir, "nope-a"), join(dir, "nope-b")],
    bundlePath,
  });

  expect(result).toBeNull();
  expect(await Bun.file(bundlePath).exists()).toBe(false);
});

test("returns null when the local CA is unreadable", async () => {
  const { dir, bundlePath } = await setup();
  const system = join(dir, "ca-certificates.crt");
  await writeFile(
    system,
    "-----BEGIN CERTIFICATE-----\nPUBLICROOT\n-----END CERTIFICATE-----\n"
  );

  const result = await writeLinuxHostTrustBundle({
    certPath: join(dir, "missing-ca.crt"),
    systemBundleCandidates: [system],
    bundlePath,
  });

  expect(result).toBeNull();
});

test("Linux trust updates the system store before building the host bundle (rotation)", async () => {
  const { configureLinuxHostTlsTrust } = await import(
    "../src/commands/global.ts"
  );
  const order: string[] = [];
  const savedHome = process.env.HACK_HOME;
  const dir = await mkdtemp(join(tmpdir(), "hack-linux-trust-order-"));
  process.env.HACK_HOME = dir;
  try {
    const ok = await configureLinuxHostTlsTrust({
      certPath: join(dir, "ca.crt"),
      applySystemTrust: async () => {
        order.push("system");
        return { ok: true, verifiedPem: "VERIFIED-PEM" };
      },
      writeBundle: async ({ localCaPem }) => {
        order.push(`bundle:${localCaPem}`);
        return null;
      },
    });
    expect(ok).toBe(true);
    // The bundle gets the verified bytes, not a re-read of the export.
    expect(order).toEqual(["system", "bundle:VERIFIED-PEM"]);
  } finally {
    restoreEnv("HACK_HOME", savedHome);
    await rm(dir, { recursive: true, force: true });
  }
});

test("a refused CA leaves the host bundle untouched", async () => {
  const { configureLinuxHostTlsTrust } = await import(
    "../src/commands/global.ts"
  );
  let wrote = false;
  const ok = await configureLinuxHostTlsTrust({
    certPath: "/nonexistent/ca.crt",
    applySystemTrust: async () => ({ ok: false, verifiedPem: null }),
    writeBundle: async () => {
      wrote = true;
      return null;
    },
  });
  expect(ok).toBe(false);
  expect(wrote).toBe(false);
});

test.each([
  false,
  true,
])("shell env uses verified bytes after export replacement (system bundle: %s)", async (hasSystemBundle) => {
  const { configureLinuxHostTlsTrust } = await import(
    "../src/commands/global.ts"
  );
  const { dir, certPath, bundlePath } = await setup();
  const savedHome = process.env.HACK_HOME;
  process.env.HACK_HOME = dir;
  try {
    await writeFile(certPath, CURRENT_CA_PEM);
    let persistedPath = "";
    expect(
      await configureLinuxHostTlsTrust({
        certPath,
        applySystemTrust: async () => {
          await writeFile(certPath, OLD_CA_PEM);
          return { ok: true, verifiedPem: CURRENT_CA_PEM };
        },
        writeBundle: async (opts) => {
          persistedPath = opts.certPath;
          expect(await Bun.file(opts.certPath).text()).toBe(CURRENT_CA_PEM);
          return hasSystemBundle ? bundlePath : null;
        },
      })
    ).toBe(true);
    expect(persistedPath).not.toBe(certPath);
    const script = await Bun.file(resolveHackHostTrustEnvScriptPath()).text();
    expect(script).toContain(`export NODE_EXTRA_CA_CERTS='${persistedPath}'`);
    expect(script).toContain(`export HACK_LOCAL_CA_CERT='${persistedPath}'`);
    expect(script).not.toContain(`'${certPath}'`);
    expect(await Bun.file(persistedPath).text()).toBe(CURRENT_CA_PEM);
    expect(await Bun.file(certPath).text()).toBe(OLD_CA_PEM);
  } finally {
    restoreEnv("HACK_HOME", savedHome);
  }
});

test("the bundle writer uses verified bytes instead of re-reading the export", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hack-linux-bundle-verified-"));
  tempDirs.add(dir);
  const system = join(dir, "system.pem");
  const exported = join(dir, "export.crt");
  const bundle = join(dir, "bundle.pem");
  await writeFile(system, "SYSTEM");
  await writeFile(exported, "REPLACED-AFTER-PROMPT");
  await writeLinuxHostTrustBundle({
    certPath: exported,
    localCaPem: "VERIFIED",
    systemBundleCandidates: [system],
    bundlePath: bundle,
  });
  expect(await Bun.file(bundle).text()).toBe("SYSTEM\nVERIFIED\n");
});
