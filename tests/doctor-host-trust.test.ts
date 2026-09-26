import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { checkMacHostTlsTrust } from "../src/lib/doctor-host-tls.ts";
import { CURRENT_CA_PEM, OLD_CA_PEM } from "./helpers/ca-certificates.ts";

test("checkMacHostTlsTrust reports ready when keychain trust and host env artifacts exist", async () => {
  const caDir = "/tmp/hack-doctor-host-trust";
  const bundlePath = resolve(caDir, "caddy-host-trust-bundle.pem");
  const envScriptPath = resolve(caDir, "caddy-host-trust-env.sh");

  const result = await checkMacHostTlsTrust({
    certPath: resolve(caDir, "caddy-local-authority.crt"),
    bundlePath,
    envScriptPath,
    pathExists: async () => true,
    readTextFile: async () => CURRENT_CA_PEM,
    exec: async () => ({ exitCode: 0, stdout: CURRENT_CA_PEM, stderr: "" }),
  });

  expect(result).toEqual({
    name: "host tls trust",
    status: "ok",
    message: `Ready (${envScriptPath})`,
  });
});

test("checkMacHostTlsTrust flags missing keychain trust and host env artifacts", async () => {
  const caDir = "/tmp/hack-doctor-host-trust";
  const bundlePath = resolve(caDir, "caddy-host-trust-bundle.pem");
  const envScriptPath = resolve(caDir, "caddy-host-trust-env.sh");

  const result = await checkMacHostTlsTrust({
    certPath: resolve(caDir, "caddy-local-authority.crt"),
    bundlePath,
    envScriptPath,
    pathExists: async () => false,
    readTextFile: async () => CURRENT_CA_PEM,
    exec: async () => ({ exitCode: 1, stdout: "", stderr: "missing" }),
  });

  expect(result.name).toBe("host tls trust");
  expect(result.status).toBe("warn");
  expect(result.message).toContain(
    "macOS System keychain is missing the current Caddy Local CA"
  );
  expect(result.message).toContain(`missing ${bundlePath}`);
  expect(result.message).toContain(`missing ${envScriptPath}`);
  expect(result.message).toContain("(run: hack doctor --fix)");
});

for (const stalePart of ["keychain", "bundle"] as const) {
  test(`doctor detects a rotated CA in the ${stalePart}`, async () => {
    const result = await checkMacHostTlsTrust({
      certPath: "/current.crt",
      bundlePath: "/bundle.pem",
      envScriptPath: "/env.sh",
      pathExists: async () => true,
      readTextFile: async (path) =>
        path === "/bundle.pem" && stalePart === "bundle"
          ? OLD_CA_PEM
          : CURRENT_CA_PEM,
      exec: async () => ({
        exitCode: 0,
        stdout: stalePart === "keychain" ? OLD_CA_PEM : CURRENT_CA_PEM,
        stderr: "",
      }),
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("current Caddy Local CA");
  });
}
