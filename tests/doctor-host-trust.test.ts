import { expect, test } from "bun:test";
import { resolve } from "node:path";

import { checkMacHostTlsTrust } from "../src/lib/doctor-host-tls.ts";

test("checkMacHostTlsTrust reports ready when keychain trust and host env artifacts exist", async () => {
  const caDir = "/tmp/hack-doctor-host-trust";
  const bundlePath = resolve(caDir, "caddy-host-trust-bundle.pem");
  const envScriptPath = resolve(caDir, "caddy-host-trust-env.sh");

  const result = await checkMacHostTlsTrust({
    certPath: resolve(caDir, "caddy-local-authority.crt"),
    bundlePath,
    envScriptPath,
    pathExists: async () => true,
    exec: async () => ({ exitCode: 0, stdout: "trusted", stderr: "" }),
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
    exec: async () => ({ exitCode: 1, stdout: "", stderr: "missing" }),
  });

  expect(result.name).toBe("host tls trust");
  expect(result.status).toBe("warn");
  expect(result.message).toContain("macOS System keychain trust missing");
  expect(result.message).toContain(`missing ${bundlePath}`);
  expect(result.message).toContain(`missing ${envScriptPath}`);
  expect(result.message).toContain("(run: hack doctor --fix)");
});
