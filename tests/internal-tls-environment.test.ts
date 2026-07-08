import { describe, expect, test } from "bun:test";

import {
  buildInternalTlsEnvironment,
  renderInternalOverride,
} from "../src/commands/project.ts";

const REPLACE_SEMANTICS_VARS = [
  "SSL_CERT_FILE",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "GIT_SSL_CAINFO",
] as const;

describe("container TLS trust environment", () => {
  test("with the combined bundle, replace-semantics vars point at the bundle, never the bare CA", () => {
    const env = buildInternalTlsEnvironment({ bundleMounted: true });

    for (const key of REPLACE_SEMANTICS_VARS) {
      expect(env[key]).toBe("/etc/hack/ca/trust-bundle.pem");
    }
    expect(env.NODE_EXTRA_CA_CERTS).toBe(
      "/etc/hack/ca/caddy-local-authority.crt"
    );
    expect(env.HACK_LOCAL_CA_CERT).toBe(
      "/etc/hack/ca/caddy-local-authority.crt"
    );
  });

  test("without the bundle, only append-semantics trust is set (public roots stay intact)", () => {
    const env = buildInternalTlsEnvironment({ bundleMounted: false });

    for (const key of REPLACE_SEMANTICS_VARS) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.NODE_EXTRA_CA_CERTS).toBe(
      "/etc/hack/ca/caddy-local-authority.crt"
    );
    expect(env.HACK_LOCAL_CA_CERT).toBe(
      "/etc/hack/ca/caddy-local-authority.crt"
    );
  });

  test("SSL_CERT_DIR is never set (it would discard the image's default cert dir)", () => {
    expect(
      buildInternalTlsEnvironment({ bundleMounted: true }).SSL_CERT_DIR
    ).toBeUndefined();
    expect(
      buildInternalTlsEnvironment({ bundleMounted: false }).SSL_CERT_DIR
    ).toBeUndefined();
  });

  test("override mounts both the CA and the bundle when available", () => {
    const yaml = renderInternalOverride({
      services: [{ name: "api", enableInternalDns: true }],
      dnsServer: null,
      extraHosts: {},
      caPath: "/home/x/.hack/caddy/pki/caddy-local-authority.crt",
      trustBundlePath: "/home/x/.hack/caddy/pki/caddy-host-trust-bundle.pem",
    });

    expect(yaml).toContain(
      "/home/x/.hack/caddy/pki/caddy-local-authority.crt:/etc/hack/ca/caddy-local-authority.crt:ro"
    );
    expect(yaml).toContain(
      "/home/x/.hack/caddy/pki/caddy-host-trust-bundle.pem:/etc/hack/ca/trust-bundle.pem:ro"
    );
    expect(yaml).toContain("SSL_CERT_FILE: /etc/hack/ca/trust-bundle.pem");
    expect(yaml).not.toContain("SSL_CERT_DIR");
  });

  test("override without the bundle mounts only the CA and sets no replace-semantics vars", () => {
    const yaml = renderInternalOverride({
      services: [{ name: "api", enableInternalDns: true }],
      dnsServer: null,
      extraHosts: {},
      caPath: "/home/x/.hack/caddy/pki/caddy-local-authority.crt",
      trustBundlePath: null,
    });

    expect(yaml).toContain(
      "NODE_EXTRA_CA_CERTS: /etc/hack/ca/caddy-local-authority.crt"
    );
    expect(yaml).not.toContain("trust-bundle.pem");
    expect(yaml).not.toContain("SSL_CERT_FILE");
    expect(yaml).not.toContain("REQUESTS_CA_BUNDLE");
  });
});
