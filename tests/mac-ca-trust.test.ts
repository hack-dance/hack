import { expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import {
  checkMacCaTrust,
  describeSupersededRoots,
  inspectSupersededMacRoots,
  inventorySupersededRoots,
} from "../src/lib/mac-ca-trust.ts";
import {
  CADDY_2025_ROOT_PEM,
  CADDY_2026_ROOT_PEM,
  CURRENT_CA_PEM,
  EXPIRED_SAME_SUBJECT_CA_PEM,
  NOT_YET_VALID_SAME_SUBJECT_CA_PEM,
  OLD_CA_PEM,
  UNRELATED_CA_PEM,
} from "./helpers/ca-certificates.ts";

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
  expect(result.installable).toBe(true);
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
    expect(result.installable).toBe(true);
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
    expect(result.installable).toBe(false);
    expect(result.issue).toContain(
      now < validNow ? "not yet valid" : "expired"
    );
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
    expect(result.installable).toBe(false);
  }
});

test("a certificate without CA basic constraints is ineligible before keychain inspection", async () => {
  const der = Buffer.from(certificate.raw);
  const constraint = der.indexOf(Buffer.from("30030101ff", "hex"));
  expect(constraint).toBeGreaterThan(0);
  der[constraint + 4] = 0;
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64")}\n-----END CERTIFICATE-----`;
  expect(new X509Certificate(pem).ca).toBe(false);
  const result = await checkMacCaTrust({
    certPath: "/non-ca.crt",
    now: validNow,
    readTextFile: async () => pem,
    exec: async () => {
      throw new Error("must not run");
    },
  });
  expect(result.installable).toBe(false);
  expect(result.issue).toContain("not a CA");
});

test("eligibility requires exactly one bounded certificate with no appended payload", async () => {
  const extraDer = Buffer.concat([certificate.raw, Buffer.from("payload")]);
  for (const pem of [
    CURRENT_CA_PEM + OLD_CA_PEM,
    `${CURRENT_CA_PEM}payload`,
    `payload${CURRENT_CA_PEM}`,
    CURRENT_CA_PEM + " ".repeat(64 * 1024),
    `-----BEGIN CERTIFICATE-----\n${extraDer.toString("base64")}\n-----END CERTIFICATE-----`,
  ]) {
    const result = await checkMacCaTrust({
      certPath: "/invalid.crt",
      now: validNow,
      readTextFile: async () => pem,
      exec: async () => {
        throw new Error("must not inspect keychain");
      },
    });
    expect(result.installable).toBe(false);
    expect(result.trusted).toBe(false);
  }
});

const fingerprint = (pem: string) =>
  createHash("sha256")
    .update(new X509Certificate(pem).raw)
    .digest("hex")
    .toUpperCase();

function keychain(stdout: string, exitCode = 0) {
  const calls: string[][] = [];
  return {
    calls,
    exec: async (cmd: readonly string[]) => {
      calls.push([...cmd]);
      return { exitCode, stdout, stderr: "" };
    },
  };
}

test("superseded inventory classifies same-subject roots by exact DER and validity", async () => {
  const listing =
    OLD_CA_PEM +
    CURRENT_CA_PEM +
    EXPIRED_SAME_SUBJECT_CA_PEM +
    NOT_YET_VALID_SAME_SUBJECT_CA_PEM +
    UNRELATED_CA_PEM +
    OLD_CA_PEM;
  const k = keychain(listing);
  const result = await checkMacCaTrust({
    certPath: "/current.crt",
    now: validNow,
    readTextFile: async () => CURRENT_CA_PEM,
    exec: k.exec,
  });
  expect(result.trusted).toBe(true);
  expect(result.supersededRoots).toEqual({
    count: 3,
    expired: 1,
    notYetValid: 1,
    sha256: [
      fingerprint(OLD_CA_PEM),
      fingerprint(EXPIRED_SAME_SUBJECT_CA_PEM),
      fingerprint(NOT_YET_VALID_SAME_SUBJECT_CA_PEM),
    ].sort(),
  });
  expect(result.supersededRoots?.sha256).not.toContain(
    fingerprint(CURRENT_CA_PEM)
  );
  expect(result.supersededRoots?.sha256).not.toContain(
    fingerprint(UNRELATED_CA_PEM)
  );
  // The inventory reuses the one existing keychain listing and never mutates it.
  expect(k.calls.filter((cmd) => cmd[1] === "find-certificate")).toHaveLength(
    1
  );
  expect(k.calls.some((cmd) => cmd.includes("delete-certificate"))).toBe(false);
});

test("superseded roots are still inventoried when the current root is absent", async () => {
  const result = await checkMacCaTrust({
    certPath: "/current.crt",
    now: validNow,
    readTextFile: async () => CURRENT_CA_PEM,
    exec: keychain(OLD_CA_PEM + UNRELATED_CA_PEM).exec,
  });
  expect(result.trusted).toBe(false);
  expect(result.supersededRoots).toEqual({
    count: 1,
    expired: 0,
    notYetValid: 0,
    sha256: [fingerprint(OLD_CA_PEM)],
  });
});

test("a stale year-named Caddy root is grouped with the live root's family", () => {
  const current = new X509Certificate(CADDY_2026_ROOT_PEM);
  expect(new X509Certificate(CADDY_2025_ROOT_PEM).subject).not.toBe(
    current.subject
  );
  const inventory = inventorySupersededRoots({
    pem: CADDY_2025_ROOT_PEM + CADDY_2026_ROOT_PEM + CURRENT_CA_PEM,
    certificate: current,
    now: Date.parse(current.validFrom) + 1000,
  });
  expect(inventory).toEqual({
    count: 1,
    expired: 0,
    notYetValid: 0,
    sha256: [fingerprint(CADDY_2025_ROOT_PEM)],
  });
});

test("an unreadable keychain listing yields no inventory instead of a zero count", async () => {
  const result = await checkMacCaTrust({
    certPath: "/current.crt",
    now: validNow,
    readTextFile: async () => CURRENT_CA_PEM,
    exec: keychain(OLD_CA_PEM, 1).exec,
  });
  expect(result.supersededRoots).toBeUndefined();
  expect(
    await inspectSupersededMacRoots({
      certPath: "/current.crt",
      now: validNow,
      readTextFile: async () => CURRENT_CA_PEM,
      exec: keychain(OLD_CA_PEM, 1).exec,
    })
  ).toBeUndefined();
});

test("standalone inventory runs only the read-only keychain listing", async () => {
  const k = keychain(CURRENT_CA_PEM + EXPIRED_SAME_SUBJECT_CA_PEM);
  const inventory = await inspectSupersededMacRoots({
    certPath: "/current.crt",
    now: validNow,
    readTextFile: async () => CURRENT_CA_PEM,
    exec: k.exec,
  });
  expect(inventory).toEqual({
    count: 1,
    expired: 1,
    notYetValid: 0,
    sha256: [fingerprint(EXPIRED_SAME_SUBJECT_CA_PEM)],
  });
  expect(k.calls).toEqual([
    [
      "security",
      "find-certificate",
      "-a",
      "-p",
      "/Library/Keychains/System.keychain",
    ],
  ]);
});

test("Doctor text reports counts and fingerprints without paths or PEM", () => {
  const sha256 = [
    fingerprint(OLD_CA_PEM),
    fingerprint(EXPIRED_SAME_SUBJECT_CA_PEM),
  ];
  const described = describeSupersededRoots({
    count: 2,
    expired: 1,
    notYetValid: 0,
    sha256,
  });
  expect(described.status).toBe("warn");
  expect(described.message).toStartWith(
    "2 superseded Caddy roots remain in the macOS System keychain (1 expired)."
  );
  for (const value of sha256) {
    expect(described.message).toContain(value);
  }
  expect(described.message).not.toContain("BEGIN CERTIFICATE");
  expect(described.message).not.toContain("/Library/Keychains");
  expect(described.message).not.toContain("delete-certificate");
  expect(
    describeSupersededRoots({
      count: 0,
      expired: 0,
      notYetValid: 0,
      sha256: [],
    })
  ).toEqual({
    status: "ok",
    message: "0 superseded Caddy roots remain in the macOS System keychain.",
  });
  expect(describeSupersededRoots(undefined).status).toBe("warn");
});
