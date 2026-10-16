import { expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { checkMacCaTrust } from "../src/lib/mac-ca-trust.ts";
import { CURRENT_CA_PEM, OLD_CA_PEM } from "./helpers/ca-certificates.ts";

const certificate = new X509Certificate(CURRENT_CA_PEM);
const validNow = Date.parse(certificate.validFrom) + 1000;

test("same-name old root cannot satisfy current CA trust", async () => {
  expect(new X509Certificate(OLD_CA_PEM).subject).toBe(certificate.subject);
  const calls: string[][] = [];
  const result = await checkMacCaTrust({
    certPath: "/current.crt",
    now: validNow,
    readTextFile: async () => CURRENT_CA_PEM,
    exec: async (cmd) => {
      calls.push([...cmd]);
      return { exitCode: 0, stdout: OLD_CA_PEM, stderr: "" };
    },
  });
  expect(result.trusted).toBe(false);
  expect(calls).toHaveLength(1);
});

for (const exitCode of [0, 1]) {
  test(`exact installed root requires successful trust evaluation (exit ${exitCode})`, async () => {
    const calls: string[][] = [];
    const result = await checkMacCaTrust({
      certPath: "/current.crt",
      now: validNow,
      readTextFile: async () => CURRENT_CA_PEM,
      exec: async (cmd) => {
        calls.push([...cmd]);
        return {
          exitCode: cmd[1] === "verify-cert" ? exitCode : 0,
          stdout: OLD_CA_PEM + CURRENT_CA_PEM,
          stderr: "",
        };
      },
    });
    expect(result.trusted).toBe(exitCode === 0);
    expect(calls[1]).toEqual([
      "security",
      "verify-cert",
      "-c",
      "/current.crt",
      "-p",
      "ssl",
      "-l",
      "-k",
      "/Library/Keychains/System.keychain",
      "-L",
      "-q",
    ]);
    expect(calls[1]).not.toContain("-r");
  });
}

for (const now of [
  Date.parse(certificate.validFrom) - 1000,
  Date.parse(certificate.validTo) + 1000,
]) {
  test(`invalid certificate dates fail before keychain inspection (${now})`, async () => {
    const result = await checkMacCaTrust({
      certPath: "/current.crt",
      now,
      readTextFile: async () => CURRENT_CA_PEM,
      exec: async () => {
        throw new Error("must not run");
      },
    });
    expect(result.trusted).toBe(false);
    expect(result.issue).toContain("current time");
  });
}

test("unreadable or malformed current certificate cannot be trusted", async () => {
  for (const pem of [null, "not a certificate"]) {
    const result = await checkMacCaTrust({
      certPath: "/current.crt",
      readTextFile: async () => pem,
      exec: async () => {
        throw new Error("must not run");
      },
    });
    expect(result.trusted).toBe(false);
  }
});
