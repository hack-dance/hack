import { expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import { buildDoctorJsonData } from "../src/commands/doctor.ts";
import {
  type CaTrustDeps,
  inspectCaTrust,
  MAC_SYSTEM_KEYCHAIN,
} from "../src/lib/ca-trust-status.ts";
import type { LinuxTrustHost } from "../src/lib/linux-trust-setup.ts";
import {
  CURRENT_CA_PEM,
  EXPIRED_SAME_SUBJECT_CA_PEM,
  OLD_CA_PEM,
} from "./helpers/ca-certificates.ts";

// R16 (HACK-2218): whether the system trust store, and NSS on Linux,
// trusts the local CA, or "unknown". Read-only and bounded: only the
// queries below are issued, and a failed read is never "not trusted".

const CA_PATH = "/home/u/.hack/caddy/pki/caddy-local-authority.crt";
const NOW = Date.parse("2027-01-01T00:00:00Z");
const DEBIAN = "ID=ubuntu\nID_LIKE=debian\n";
const BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const OK = { exitCode: 0, stdout: "", stderr: "" };

type Files = Record<string, string | "missing" | "unreadable">;
type Answer = { exitCode: number; stdout: string };

function deps(opts: {
  readonly platform: NodeJS.Platform;
  readonly files: Files;
  readonly answer?: (argv: readonly string[]) => Answer;
  readonly linuxHost?: LinuxTrustHost;
  readonly exists?: Record<string, boolean | "unknown">;
}): { readonly deps: CaTrustDeps; readonly queries: (readonly string[])[] } {
  const queries: (readonly string[])[] = [];
  return {
    queries,
    deps: {
      platform: opts.platform,
      caPath: CA_PATH,
      readText: async (path) => {
        const value = opts.files[path] ?? "missing";
        return await Promise.resolve(
          value === "missing" || value === "unreadable"
            ? value
            : { text: value }
        );
      },
      query: async (argv) => {
        queries.push(argv);
        return await Promise.resolve({
          ...(opts.answer?.(argv) ?? { exitCode: 1, stdout: "" }),
          stderr: "",
        });
      },
      ...(opts.linuxHost ? { linuxHost: opts.linuxHost } : {}),
      exists: async (path) =>
        await Promise.resolve(opts.exists?.[path] ?? false),
      now: () => NOW,
    },
  };
}

test("no usable exported CA: every store is unknown, and nothing is queried", async () => {
  for (const [value, caState] of [
    ["missing", "missing"],
    ["unreadable", "unreadable"],
    [EXPIRED_SAME_SUBJECT_CA_PEM, "invalid"],
  ] as const) {
    for (const platform of ["darwin", "linux"] as const) {
      const { deps: d, queries } = deps({
        platform,
        files: { [CA_PATH]: value, "/etc/os-release": DEBIAN },
      });
      const report = await inspectCaTrust(d);
      expect({
        platform,
        caState: report.ca.state,
        state: report.state,
      }).toEqual({ platform, caState, state: "unknown" });
      expect(queries).toEqual([]);
    }
  }
});

test("macOS: the keychain must hold and trust the exact CA; a failed query is unknown", async () => {
  const run = async (listing: Answer, verify: Answer) => {
    const { deps: d, queries } = deps({
      platform: "darwin",
      files: { [CA_PATH]: CURRENT_CA_PEM },
      answer: (argv) => (argv[1] === "find-certificate" ? listing : verify),
    });
    const report = await inspectCaTrust(d);
    return { report, queries };
  };
  const listed = { exitCode: 0, stdout: `${OLD_CA_PEM}${CURRENT_CA_PEM}` };
  const trusted = await run(listed, { exitCode: 0, stdout: "" });
  expect(trusted.report.state).toBe("trusted");
  expect(trusted.report.system.store).toBe(MAC_SYSTEM_KEYCHAIN);
  // Only these two read-only queries, local trust settings only (-L).
  expect(trusted.queries).toEqual([
    ["security", "find-certificate", "-a", "-p", MAC_SYSTEM_KEYCHAIN],
    [
      "security",
      "verify-cert",
      "-c",
      CA_PATH,
      "-p",
      "ssl",
      "-l",
      "-k",
      MAC_SYSTEM_KEYCHAIN,
      "-L",
      "-q",
    ],
  ]);
  expect((await run({ exitCode: 1, stdout: "" }, OK)).report.state).toBe(
    "unknown"
  );
  expect((await run({ exitCode: 124, stdout: "" }, OK)).report.state).toBe(
    "unknown"
  );
  // Holds only an older root: not trusted, and verify-cert is not asked.
  const older = await run({ exitCode: 0, stdout: OLD_CA_PEM }, OK);
  expect(older.report.state).toBe("not_trusted");
  expect(older.queries).toHaveLength(1);
  expect((await run(listed, { exitCode: 1, stdout: "" })).report.state).toBe(
    "not_trusted"
  );
  expect((await run(listed, { exitCode: 124, stdout: "" })).report.state).toBe(
    "unknown"
  );
});

test("Linux system store: the distribution's bundle must contain the exact CA", async () => {
  const run = async (files: Files) =>
    (
      await inspectCaTrust(
        deps({
          platform: "linux",
          files: { [CA_PATH]: CURRENT_CA_PEM, ...files },
        }).deps
      )
    ).system;
  expect(
    await run({ "/etc/os-release": DEBIAN, [BUNDLE]: CURRENT_CA_PEM })
  ).toMatchObject({
    store: BUNDLE,
    state: "trusted",
  });
  expect(
    await run({ "/etc/os-release": DEBIAN, [BUNDLE]: OLD_CA_PEM })
  ).toMatchObject({
    state: "not_trusted",
  });
  expect(
    await run({ "/etc/os-release": DEBIAN, [BUNDLE]: "missing" })
  ).toMatchObject({
    state: "not_trusted",
  });
  expect(
    await run({ "/etc/os-release": DEBIAN, [BUNDLE]: "unreadable" })
  ).toMatchObject({
    state: "unknown",
  });
  expect(await run({ "/etc/os-release": "unreadable" })).toMatchObject({
    state: "unknown",
  });
  expect(await run({ "/etc/os-release": "ID=plan9\n" })).toMatchObject({
    state: "unknown",
  });
});

function fakeHost(opts: {
  readonly profiles: readonly string[];
  readonly certutil: string | null;
}): LinuxTrustHost {
  const firefox = "/home/u/.mozilla/firefox";
  return {
    homeDir: "/home/u",
    configHome: "/home/u/.config",
    dataHome: "/home/u/.local/share",
    uid: 1000,
    readFile: async () => await Promise.resolve(null),
    listDir: async (path) =>
      await Promise.resolve(
        path === firefox
          ? [...opts.profiles]
          : opts.profiles.some((p) => path === `${firefox}/${p}`)
            ? ["cert9.db"]
            : []
      ),
    inspectPath: async () => await Promise.resolve(null),
    makeDir: async () => {
      throw new Error("never creates");
    },
    resolveCommand: async (name) =>
      await Promise.resolve(name === "certutil" ? opts.certutil : null),
    resolveSudo: async () => {
      throw new Error("never asks for sudo");
    },
    exec: async () => {
      throw new Error("uses the bounded query instead");
    },
    runPrivileged: async () => {
      throw new Error("never runs privileged");
    },
  };
}

test("Linux NSS: each existing database is listed read-only; trust needs TLS issuer flags and the exact CA", async () => {
  const profile = "/home/u/.mozilla/firefox/abc.default";
  const listing = (flags: string) => ({
    exitCode: 0,
    stdout: `Certificate Nickname   Trust Attributes\n\nHack Caddy Local CA    ${flags}\n`,
  });
  const run = async (opts: {
    readonly list: Answer;
    readonly exported?: Answer;
    readonly certutil?: string | null;
    readonly exists?: boolean | "unknown";
  }) => {
    const { deps: d, queries } = deps({
      platform: "linux",
      files: {
        [CA_PATH]: CURRENT_CA_PEM,
        "/etc/os-release": DEBIAN,
        [BUNDLE]: CURRENT_CA_PEM,
      },
      linuxHost: fakeHost({
        profiles: ["abc.default"],
        certutil:
          opts.certutil === undefined ? "/usr/bin/certutil" : opts.certutil,
      }),
      exists: { [`${profile}/cert9.db`]: opts.exists ?? true },
      answer: (argv) =>
        argv.includes("-a")
          ? (opts.exported ?? { exitCode: 1, stdout: "" })
          : opts.list,
    });
    const report = await inspectCaTrust(d);
    return { report, queries, db: report.nss.find((db) => db.db === profile) };
  };
  const trusted = await run({
    list: listing("C,,"),
    exported: { exitCode: 0, stdout: CURRENT_CA_PEM },
  });
  expect(trusted.db?.state).toBe("trusted");
  expect(trusted.report.state).toBe("trusted");
  // Only list and export, never add/modify/create/delete.
  for (const argv of trusted.queries) {
    expect(argv.slice(1, 3)).toEqual(["-d", `sql:${profile}`]);
    expect(argv[3]).toBe("-L");
    for (const flag of ["-A", "-M", "-N", "-D"]) {
      expect(argv).not.toContain(flag);
    }
  }
  expect((await run({ list: listing(",,") })).db?.state).toBe("not_trusted");
  expect((await run({ list: { exitCode: 0, stdout: "" } })).db?.state).toBe(
    "not_trusted"
  );
  const notTrusted = await run({
    list: listing("C,,"),
    exported: { exitCode: 0, stdout: OLD_CA_PEM },
  });
  expect(notTrusted.db?.state).toBe("not_trusted");
  expect(notTrusted.report.state).toBe("not_trusted");
  expect((await run({ list: { exitCode: 124, stdout: "" } })).db?.state).toBe(
    "unknown"
  );
  expect(
    (await run({ list: listing("C,,"), exported: { exitCode: 1, stdout: "" } }))
      .db?.state
  ).toBe("unknown");
  expect((await run({ list: listing("C,,"), certutil: null })).db?.state).toBe(
    "unknown"
  );
  const unknownDb = await run({ list: listing("C,,"), exists: "unknown" });
  expect(unknownDb.db?.state).toBe("unknown");
  expect(unknownDb.report.state).toBe("unknown");
  // A profile without cert9.db is not a database: nothing to check.
  const none = await run({ list: listing("C,,"), exists: false });
  expect(none.db).toBeUndefined();
  expect(none.queries).toEqual([]);
});

test("other platforms are unknown", async () => {
  const report = await inspectCaTrust(
    deps({ platform: "win32", files: { [CA_PATH]: CURRENT_CA_PEM } }).deps
  );
  expect(report.state).toBe("unknown");
  expect(report.ca.fingerprint256).toBe(
    new X509Certificate(CURRENT_CA_PEM).fingerprint256
  );
});

test("doctor --json carries the trust report on its check", () => {
  const caTrust = {
    platform: "linux",
    ca: { path: CA_PATH, state: "valid" as const, fingerprint256: "AA" },
    system: { store: BUNDLE, state: "trusted" as const, detail: "" },
    nss: [],
    state: "trusted" as const,
  };
  const data = buildDoctorJsonData({
    results: [
      {
        name: "local ca trust",
        status: "ok",
        message: "Trusted",
        durationMs: 1,
        caTrust,
      },
    ],
  });
  expect(data.checks[0]).toMatchObject({ id: "local ca trust", caTrust });
});
