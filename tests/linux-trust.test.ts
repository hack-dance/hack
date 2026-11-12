import { describe, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CaddyCaIdentity } from "../src/lib/caddy-ca-identity.ts";
import {
  bundleContainsCertificate,
  detectLinuxDistroFamily,
  findOtherCaddyRoots,
  hasTlsIssuerTrust,
  linuxSystemTrustCommands,
  linuxSystemTrustInstallArgv,
  NSS_CA_NICKNAME,
  parseNssTrustFlags,
  renderShellCommand,
  renderUnknownDistroTrustSteps,
  type ValidatedCa,
  VERIFIED_ANCHOR_INSTALL_SCRIPT,
  VERIFIED_TRUST_ANCHOR_SCRIPT,
  validateCaddyRootPem,
} from "../src/lib/linux-trust.ts";
import {
  createLinuxTrustHost,
  resolveExecutable,
} from "../src/lib/linux-trust-host.ts";
import {
  applyLinuxNssTrust,
  applyLinuxSystemTrust,
  type LinuxTrustHost,
  type ResolvedPathInfo,
} from "../src/lib/linux-trust-setup.ts";
import {
  CURRENT_CA_PEM,
  EXPIRED_SAME_SUBJECT_CA_PEM,
  INTERMEDIATE_CA_PEM,
  NON_CA_LEAF_PEM,
  OLD_CA_PEM,
  UNRELATED_CA_PEM,
} from "./helpers/ca-certificates.ts";

const UID = 1000;
const HOME = "/fake-home";
const STAGED = "/fake-private/caddy-local-ca.crt";
const EXPORT = `${HOME}/.hack/caddy/pki/caddy-local-authority.crt`;
const CERTUTIL = "/usr/bin/certutil";
const SQL_PREFIX = /^sql:/;
const PEM_ARMOR = /-----[^-]+-----/g;
const ANY_WHITESPACE = /\s/g;
const BASE64_CHUNK = /.{1,40}/g;
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const OS_RELEASE = {
  ubuntu: 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n',
  debian: "ID=debian\n",
  arch: "ID=arch\n",
  endeavour: "ID=endeavouros\nID_LIKE=arch\n",
  fedora: "ID=fedora\nVERSION_ID=41\n",
  rocky: 'ID="rocky"\nID_LIKE="rhel centos fedora"\n',
  opensuse: 'ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n',
  alpine: "ID=alpine\n",
} as const;

async function validated(pem: string): Promise<ValidatedCa> {
  const result = await validateCaddyRootPem({ pem });
  if (!result.ok) {
    throw new Error(result.issue);
  }
  return result.ca;
}

type NssEntry = { pem: string; flags: string };

type FakeState = {
  files: Map<string, string>;
  /** Existing directories and their entry names. */
  dirs: Map<string, string[]>;
  /** Symlinks: path prefix → resolved prefix. */
  links: Map<string, string>;
  /** Owner and mode overrides by resolved path. */
  meta: Map<string, { uid: number; mode: number }>;
  commands: Set<string>;
  privileged: string[][];
  execs: string[][];
  identities: Map<string, string>;
  /** NSS entries under Hack's nickname, by resolved db dir. */
  nss: Map<string, NssEntry[]>;
  failCertutil?: string;
};

function bundleForAnchor(target: string): string {
  if (target.startsWith("/usr/local/share")) {
    return "/etc/ssl/certs/ca-certificates.crt";
  }
  if (target.startsWith("/etc/pki/ca-trust")) {
    return "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem";
  }
  return "/var/lib/ca-certificates/ca-bundle.pem";
}

/**
 * In-memory host whose certutil and root steps enforce the real tools'
 * preconditions: an absolute binary path, `-N` needs an existing directory,
 * other operations need an existing database, `-A` refuses a duplicate
 * nickname, `-M` needs an entry, and root installs only digest-matching bytes.
 */
function createFakeHost(init: {
  readonly osRelease?: string | null;
  readonly files?: Record<string, string>;
  readonly dirs?: Record<string, string[]>;
  readonly links?: Record<string, string>;
  readonly meta?: Record<string, { uid: number; mode: number }>;
  readonly commands?: readonly string[];
  readonly nss?: Record<string, NssEntry[]>;
  readonly failCertutil?: string;
}): { host: LinuxTrustHost; state: FakeState } {
  const files = new Map(Object.entries(init.files ?? {}));
  files.set(STAGED, CURRENT_CA_PEM);
  const osRelease =
    init.osRelease === undefined ? OS_RELEASE.ubuntu : init.osRelease;
  if (osRelease !== null) {
    files.set("/etc/os-release", osRelease);
  }
  const state: FakeState = {
    files,
    dirs: new Map([
      [HOME, []],
      [`${HOME}/.config`, []],
      ...Object.entries(init.dirs ?? {}),
    ]),
    links: new Map(Object.entries(init.links ?? {})),
    meta: new Map(Object.entries(init.meta ?? {})),
    commands: new Set(init.commands ?? []),
    privileged: [],
    execs: [],
    identities: new Map(),
    nss: new Map(Object.entries(init.nss ?? {})),
    failCertutil: init.failCertutil,
  };
  for (const dir of [...state.dirs.keys()]) {
    for (
      let parent = dir.slice(0, dir.lastIndexOf("/")) || "/";
      ;
      parent = parent.slice(0, parent.lastIndexOf("/")) || "/"
    ) {
      if (!state.dirs.has(parent)) {
        state.dirs.set(parent, []);
      }
      if (parent === "/") {
        break;
      }
    }
  }
  const resolve = (path: string): string => {
    for (const [from, to] of state.links) {
      if (path === from || path.startsWith(`${from}/`)) {
        return to + path.slice(from.length);
      }
    }
    return path;
  };
  const hasDb = (db: string) => state.dirs.get(db)?.includes("cert9.db");
  const refresh = (bundle: string) => {
    state.files.set(
      bundle,
      `${UNRELATED_CA_PEM}${state.files.get(`anchor:${bundle}`) ?? ""}`
    );
  };
  const nssOp = (
    op: string | undefined,
    argv: readonly string[],
    db: string,
    input?: string
  ) => {
    const entries = state.nss.get(db) ?? [];
    switch (op) {
      case "-L":
        if (argv[4] === "-n") {
          return entries.length > 0
            ? { exitCode: 0, stdout: entries.map((e) => e.pem).join("") }
            : { exitCode: 255, stdout: "" };
        }
        return {
          exitCode: 0,
          stdout: `\nCertificate Nickname${" ".repeat(41)}Trust Attributes\n${entries
            .map((e) => `${NSS_CA_NICKNAME.padEnd(60)}${e.flags}`)
            .join("\n")}\n`,
        };
      case "-D":
        if (entries.length === 0) {
          return { exitCode: 255, stdout: "" };
        }
        state.nss.set(db, entries.slice(1));
        return { exitCode: 0, stdout: "" };
      case "-A":
        if (entries.length > 0) {
          return { exitCode: 255, stdout: "" };
        }
        state.nss.set(db, [
          {
            pem: input ?? "",
            flags: argv[5] ?? "",
          },
        ]);
        return { exitCode: 0, stdout: "" };
      case "-M": {
        const [first, ...rest] = entries;
        if (!first) {
          return { exitCode: 255, stdout: "" };
        }
        state.nss.set(db, [{ ...first, flags: argv.at(-1) ?? "" }, ...rest]);
        return { exitCode: 0, stdout: "" };
      }
      default:
        return { exitCode: 1, stdout: "" };
    }
  };
  const certutil = (argv: readonly string[], input?: string) => {
    const db = resolve((argv[2] ?? "").replace(SQL_PREFIX, ""));
    const op = argv[3];
    if (state.failCertutil === op) {
      return { exitCode: 255, stdout: "" };
    }
    if (op === "-N") {
      // Real certutil -N creates database files, never their directory.
      if (!state.dirs.has(db) || hasDb(db)) {
        return { exitCode: 255, stdout: "" };
      }
      state.dirs.set(db, ["cert9.db", "key4.db"]);
      return { exitCode: 0, stdout: "" };
    }
    if (!hasDb(db)) {
      return { exitCode: 255, stdout: "" };
    }
    return nssOp(op, argv, db, input);
  };
  const plainRoot = (argv: readonly string[]) => {
    if (argv[0] === "update-ca-certificates") {
      refresh("/etc/ssl/certs/ca-certificates.crt");
      refresh("/var/lib/ca-certificates/ca-bundle.pem");
    } else if (argv[0] === "update-ca-trust") {
      refresh("/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem");
      refresh("/etc/ssl/certs/ca-certificates.crt");
    }
    return 0;
  };
  const host: LinuxTrustHost = {
    homeDir: HOME,
    configHome: `${HOME}/.config`,
    dataHome: `${HOME}/.local/share`,
    uid: UID,
    readFile: async (path) => state.files.get(resolve(path)) ?? null,
    listDir: async (path) => state.dirs.get(resolve(path)) ?? [],
    inspectPath: async (path): Promise<ResolvedPathInfo | null> => {
      const realPath = resolve(path);
      const isDirectory = state.dirs.has(realPath);
      const parent = realPath.slice(0, realPath.lastIndexOf("/"));
      const name = realPath.slice(realPath.lastIndexOf("/") + 1);
      const isFile = state.dirs.get(parent)?.includes(name) === true;
      if (!(isDirectory || isFile)) {
        return null;
      }
      const meta = state.meta.get(realPath) ?? {
        uid: UID,
        mode: isDirectory ? 0o4_0700 : 0o10_0600,
      };
      return {
        realPath,
        isDirectory,
        isFile,
        identity: state.identities.get(realPath) ?? realPath,
        ...meta,
      };
    },
    makeDir: async (path) => {
      const real = resolve(path);
      for (
        let parent = real;
        ;
        parent = parent.slice(0, parent.lastIndexOf("/")) || "/"
      ) {
        if (!state.dirs.has(parent)) {
          state.dirs.set(parent, []);
        }
        if (parent === "/") {
          break;
        }
      }
      return true;
    },
    resolveCommand: async (name) =>
      state.commands.has(name) ? `/usr/bin/${name}` : null,
    exec: async (argv, input) => {
      state.execs.push([...argv]);
      // Spawning needs the resolved binary; a bare name is not on PATH here.
      if (argv[0] !== CERTUTIL) {
        return { exitCode: 127, stdout: "" };
      }
      return certutil(argv, input);
    },
    runPrivileged: async (argv, input) => {
      state.privileged.push([...argv]);
      if (argv[0] !== "/bin/sh") {
        return plainRoot(argv);
      }
      // Mirror the verified scripts: act only on bytes matching the digest.
      const content = input ?? "";
      if (
        sha256(content) !== argv[5] ||
        Buffer.byteLength(content) !== Number(argv[4])
      ) {
        return 1;
      }
      if (argv[2] === VERIFIED_ANCHOR_INSTALL_SCRIPT) {
        state.files.set(`anchor:${bundleForAnchor(argv[6] ?? "")}`, content);
      } else if (argv[2] === VERIFIED_TRUST_ANCHOR_SCRIPT) {
        // Like p11-kit: store the anchor; the extract step refreshes bundles.
        const bundle = "/etc/ssl/certs/ca-certificates.crt";
        state.files.set(
          `anchor:${bundle}`,
          `${state.files.get(`anchor:${bundle}`) ?? ""}${content}`
        );
      }
      return 0;
    },
  };
  return { host, state };
}

const noShow = () => undefined;
const yes = async () => true;

describe("distro detection", () => {
  test.each([
    ["ubuntu", "debian"],
    ["debian", "debian"],
    ["arch", "arch"],
    ["endeavour", "arch"],
    ["fedora", "fedora"],
    ["rocky", "fedora"],
    ["opensuse", "suse"],
  ] as const)("%s → %s", (name, family) => {
    expect(detectLinuxDistroFamily(OS_RELEASE[name])).toBe(family);
  });

  test("unknown or missing os-release", () => {
    expect(detectLinuxDistroFamily(OS_RELEASE.alpine)).toBeNull();
    expect(detectLinuxDistroFamily(null)).toBeNull();
  });
});

describe("CA validation (finding 1)", () => {
  test("accepts exactly one valid self-signed CA and reports its fingerprint", async () => {
    const result = await validateCaddyRootPem({ pem: CURRENT_CA_PEM });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ca.fingerprint256).toBe(
        new X509Certificate(CURRENT_CA_PEM).fingerprint256
      );
      expect(result.ca.pemSha256).toBe(sha256(CURRENT_CA_PEM));
    }
  });

  test.each([
    ["an end-entity (non-CA) certificate", NON_CA_LEAF_PEM],
    ["a CA that is not self-signed", INTERMEDIATE_CA_PEM],
    ["an expired root", EXPIRED_SAME_SUBJECT_CA_PEM],
    ["two certificates", `${CURRENT_CA_PEM}\n${OLD_CA_PEM}`],
    ["an empty file", ""],
    ["text that is not a certificate", "not a certificate"],
  ])("refuses %s", async (_label, pem) => {
    expect((await validateCaddyRootPem({ pem })).ok).toBe(false);
  });
});

describe("system trust commands", () => {
  test("each family gets its own anchor location and refresh step", () => {
    const sha = sha256(CURRENT_CA_PEM);
    expect(
      linuxSystemTrustCommands({
        family: "debian",
        certPath: STAGED,
        sha256: sha,
        byteLength: Buffer.byteLength(CURRENT_CA_PEM),
      })
    ).toEqual([
      [
        "/bin/sh",
        "-c",
        'exec sudo "$@" < "$0"',
        STAGED,
        ...linuxSystemTrustInstallArgv({
          family: "debian",
          sha256: sha,
          byteLength: Buffer.byteLength(CURRENT_CA_PEM),
        }),
      ],
      ["sudo", "update-ca-certificates"],
    ]);
    expect(
      linuxSystemTrustCommands({
        family: "fedora",
        certPath: STAGED,
        sha256: sha,
        byteLength: Buffer.byteLength(CURRENT_CA_PEM),
      }).at(-1)
    ).toEqual(["sudo", "update-ca-trust", "extract"]);
    expect(
      linuxSystemTrustCommands({
        family: "arch",
        certPath: STAGED,
        sha256: sha,
        byteLength: Buffer.byteLength(CURRENT_CA_PEM),
      })
    ).toEqual([
      [
        "/bin/sh",
        "-c",
        'exec sudo "$@" < "$0"',
        STAGED,
        ...linuxSystemTrustInstallArgv({
          family: "arch",
          sha256: sha,
          byteLength: Buffer.byteLength(CURRENT_CA_PEM),
        }),
      ],
      ["sudo", "update-ca-trust", "extract"],
    ]);
  });

  test("unknown-distro steps use the same arrays and quoting (finding 5)", () => {
    const certPath = "/tmp/a dir/$(touch pwned);x.crt";
    const sha = sha256(CURRENT_CA_PEM);
    const steps = renderUnknownDistroTrustSteps({
      certPath,
      sha256: sha,
      byteLength: Buffer.byteLength(CURRENT_CA_PEM),
    }).join("\n");
    for (const command of linuxSystemTrustCommands({
      family: "debian",
      certPath,
      sha256: sha,
      byteLength: Buffer.byteLength(CURRENT_CA_PEM),
    })) {
      expect(steps).toContain(renderShellCommand(command));
    }
    expect(steps).toContain("'/tmp/a dir/$(touch pwned);x.crt'");
    expect(steps).not.toContain(" /tmp/a dir/");
  });

  test("bundle matching ignores PEM line wrapping", () => {
    const body = CURRENT_CA_PEM.replace(PEM_ARMOR, "").replace(
      ANY_WHITESPACE,
      ""
    );
    const rewrapped = `-----BEGIN CERTIFICATE-----\n${body.match(BASE64_CHUNK)?.join("\n")}\n-----END CERTIFICATE-----`;
    expect(
      bundleContainsCertificate({
        bundle: `${UNRELATED_CA_PEM}${rewrapped}`,
        certPem: CURRENT_CA_PEM,
      })
    ).toBe(true);
    expect(
      bundleContainsCertificate({
        bundle: UNRELATED_CA_PEM,
        certPem: CURRENT_CA_PEM,
      })
    ).toBe(false);
  });

  test("other Caddy roots in the bundle are listed by fingerprint", () => {
    expect(
      findOtherCaddyRoots({
        bundle: `${UNRELATED_CA_PEM}${OLD_CA_PEM}${CURRENT_CA_PEM}`,
        current: new X509Certificate(CURRENT_CA_PEM),
      })
    ).toEqual([new X509Certificate(OLD_CA_PEM).fingerprint256]);
  });
});

describe("applyLinuxSystemTrust", () => {
  test.each([
    ["ubuntu", "update-ca-certificates"],
    ["fedora", "update-ca-trust"],
    ["arch", "trust update-ca-trust"],
    ["opensuse", "update-ca-certificates"],
  ] as const)("%s: confirmed run trusts the staged CA", async (name, tools) => {
    const ca = await validated(CURRENT_CA_PEM);
    const { host, state } = createFakeHost({
      osRelease: OS_RELEASE[name],
      commands: tools.split(" "),
    });
    const shown: string[] = [];
    const outcome = await applyLinuxSystemTrust({
      host,
      ca,
      manualCertPath: EXPORT,
      canPrompt: true,
      show: (_commands, fingerprint) => shown.push(fingerprint),
      confirm: yes,
    });
    expect(outcome.status).toBe("trusted");
    expect(shown).toEqual([ca.fingerprint256]);
    expect(
      state.privileged.every((argv) => argv.every((a) => !a.startsWith(HOME)))
    ).toBe(true);
  });

  test("Arch: a previous Caddy root still in the bundle is reported", async () => {
    const { host } = createFakeHost({
      osRelease: OS_RELEASE.arch,
      commands: ["trust", "update-ca-trust"],
      files: { "anchor:/etc/ssl/certs/ca-certificates.crt": OLD_CA_PEM },
    });
    const outcome = await applyLinuxSystemTrust({
      host,
      ca: await validated(CURRENT_CA_PEM),
      manualCertPath: EXPORT,
      canPrompt: true,
      show: noShow,
      confirm: yes,
    });
    expect(outcome).toMatchObject({
      status: "trusted",
      otherCaddyRoots: [new X509Certificate(OLD_CA_PEM).fingerprint256],
    });
  });

  test("already trusted: no prompt, nothing runs", async () => {
    const { host, state } = createFakeHost({
      commands: ["update-ca-certificates"],
      files: {
        "/etc/ssl/certs/ca-certificates.crt": `${UNRELATED_CA_PEM}${CURRENT_CA_PEM}`,
      },
    });
    const outcome = await applyLinuxSystemTrust({
      host,
      ca: await validated(CURRENT_CA_PEM),
      manualCertPath: EXPORT,
      canPrompt: true,
      show: () => {
        throw new Error("no plan expected");
      },
      confirm: async () => {
        throw new Error("no prompt expected");
      },
    });
    expect(outcome).toEqual({
      status: "trusted",
      family: "debian",
      otherCaddyRoots: [],
    });
    expect(state.privileged).toEqual([]);
  });

  test("non-interactive: no prompt and no root command; commands returned", async () => {
    const { host, state } = createFakeHost({
      osRelease: OS_RELEASE.fedora,
      commands: ["update-ca-trust"],
    });
    const outcome = await applyLinuxSystemTrust({
      host,
      ca: await validated(CURRENT_CA_PEM),
      manualCertPath: EXPORT,
      canPrompt: false,
      show: () => {
        throw new Error("must not show a prompt plan");
      },
      confirm: async () => {
        throw new Error("must not prompt");
      },
    });
    expect(outcome).toMatchObject({
      status: "pending",
      code: "linux_trust_system_pending",
    });
    expect(state.privileged).toEqual([]);
    // The printed commands outlive the private staged copy: they name the
    // persistent export and still carry the approved digest.
    if (outcome.status === "pending") {
      expect(outcome.commands[0]).toContain(EXPORT);
      expect(outcome.commands[0]).toContain(sha256(CURRENT_CA_PEM));
      expect(outcome.commands.flat()).not.toContain(STAGED);
    }
  });

  test("declined is pending and runs nothing", async () => {
    const { host, state } = createFakeHost({
      commands: ["update-ca-certificates"],
    });
    const outcome = await applyLinuxSystemTrust({
      host,
      ca: await validated(CURRENT_CA_PEM),
      manualCertPath: EXPORT,
      canPrompt: true,
      show: noShow,
      confirm: async () => false,
    });
    expect(outcome.status).toBe("pending");
    expect(state.privileged).toEqual([]);
  });

  test("replaced staged bytes cannot affect root input", async () => {
    const { host, state } = createFakeHost({
      commands: ["update-ca-certificates"],
    });
    const outcome = await applyLinuxSystemTrust({
      host,
      ca: await validated(CURRENT_CA_PEM),
      manualCertPath: EXPORT,
      canPrompt: true,
      show: noShow,
      confirm: async () => {
        state.files.set(STAGED, OLD_CA_PEM);
        return true;
      },
    });
    expect(outcome).toMatchObject({ status: "trusted" });
    expect(state.files.has("anchor:/etc/ssl/certs/ca-certificates.crt")).toBe(
      true
    );
  });

  test("unknown distro and missing tool give manual steps without sudo", async () => {
    const unknown = createFakeHost({ osRelease: OS_RELEASE.alpine });
    expect(
      await applyLinuxSystemTrust({
        host: unknown.host,
        ca: await validated(CURRENT_CA_PEM),
        manualCertPath: EXPORT,
        canPrompt: true,
        show: noShow,
        confirm: yes,
      })
    ).toMatchObject({ status: "manual", code: "linux_trust_distro_unknown" });
    // Arch needs both trust and update-ca-trust; trust alone is not enough.
    const missing = createFakeHost({
      osRelease: OS_RELEASE.arch,
      commands: ["trust"],
    });
    expect(
      await applyLinuxSystemTrust({
        host: missing.host,
        ca: await validated(CURRENT_CA_PEM),
        manualCertPath: EXPORT,
        canPrompt: true,
        show: noShow,
        confirm: yes,
      })
    ).toMatchObject({ status: "manual", code: "linux_trust_tool_missing" });
    expect([...unknown.state.privileged, ...missing.state.privileged]).toEqual(
      []
    );
  });

  test("root install argv never contains the user certificate path", () => {
    for (const family of ["debian", "fedora", "suse", "arch"] as const) {
      const argv = linuxSystemTrustInstallArgv({
        family,
        sha256: sha256(CURRENT_CA_PEM),
        byteLength: Buffer.byteLength(CURRENT_CA_PEM),
      });
      expect(argv).not.toContain(STAGED);
      expect(argv).not.toContain(EXPORT);
      expect(argv[4]).toBe(String(Buffer.byteLength(CURRENT_CA_PEM)));
    }
  });
});

describe("NSS trust flags (finding 4)", () => {
  test("parses the row for Hack's nickname", () => {
    const listing = `\nCertificate Nickname                                         Trust Attributes\n                                                             SSL,S/MIME,JAR/XPI\n\n${NSS_CA_NICKNAME.padEnd(61)}C,,\nOther CA                                                     CT,C,C\n`;
    expect(parseNssTrustFlags({ listing })).toBe("C,,");
    expect(hasTlsIssuerTrust("C,,")).toBe(true);
    expect(hasTlsIssuerTrust("CT,C,C")).toBe(true);
    expect(hasTlsIssuerTrust(",,")).toBe(false);
    expect(hasTlsIssuerTrust("P,,")).toBe(false);
    expect(hasTlsIssuerTrust(null)).toBe(false);
  });
});

describe("applyLinuxNssTrust", () => {
  const userDb = `${HOME}/.pki/nssdb`;
  const firefoxRoot = `${HOME}/.mozilla/firefox`;
  const profile = `${firefoxRoot}/abcd.default-release`;

  async function nss(host: LinuxTrustHost) {
    return await applyLinuxNssTrust({
      host,
      ca: await validated(CURRENT_CA_PEM),
    });
  }

  test("certutil missing is reported with the package to install", async () => {
    const { host } = createFakeHost({});
    const outcome = await nss(host);
    expect(outcome).toMatchObject({
      status: "certutil_missing",
      code: "linux_trust_nss_certutil_missing",
    });
    if (outcome.status === "certutil_missing") {
      expect(outcome.hint).toContain("libnss3-tools");
    }
  });

  test("creates the user db directory before certutil -N, then adds with C,, (finding 3)", async () => {
    const { host, state } = createFakeHost({
      osRelease: OS_RELEASE.fedora,
      commands: ["certutil"],
      dirs: {
        [firefoxRoot]: ["abcd.default-release", "profiles.ini"],
        [profile]: ["cert9.db", "key4.db"],
      },
    });
    expect(await nss(host)).toEqual({
      status: "done",
      databases: [
        { dbDir: userDb, status: "added" },
        { dbDir: profile, status: "added" },
      ],
    });
    expect(state.privileged).toEqual([]);
    expect(state.execs[0]).toEqual([
      CERTUTIL,
      "-d",
      `sql:${userDb}`,
      "-N",
      "--empty-password",
    ]);
    expect(state.nss.get(userDb)).toEqual([
      { pem: CURRENT_CA_PEM, flags: "C,," },
    ]);
  });

  test("reuses Chromium's modern db when no legacy db exists, and creates nothing", async () => {
    const modern = `${HOME}/.local/share/pki/nssdb`;
    const { host, state } = createFakeHost({
      commands: ["certutil"],
      dirs: { [modern]: ["cert9.db"] },
    });
    expect(await nss(host)).toEqual({
      status: "done",
      databases: [{ dbDir: modern, status: "added" }],
    });
    expect(state.dirs.has(userDb)).toBe(false);
  });

  test("an existing legacy db takes precedence over the modern one", async () => {
    const modern = `${HOME}/.local/share/pki/nssdb`;
    const { host, state } = createFakeHost({
      commands: ["certutil"],
      dirs: { [userDb]: ["cert9.db"], [modern]: ["cert9.db"] },
    });
    expect(await nss(host)).toEqual({
      status: "done",
      databases: [{ dbDir: userDb, status: "added" }],
    });
    expect(state.nss.has(modern)).toBe(false);
  });

  test("every certutil call uses the resolved absolute path (finding 6)", async () => {
    const { host, state } = createFakeHost({
      commands: ["certutil"],
      dirs: { [userDb]: ["cert9.db"] },
    });
    await nss(host);
    expect(state.execs.length).toBeGreaterThan(0);
    expect(state.execs.every((argv) => argv[0] === CERTUTIL)).toBe(true);
  });

  test("same bytes without TLS issuer trust get C,, set (finding 4)", async () => {
    const { host, state } = createFakeHost({
      commands: ["certutil"],
      dirs: { [userDb]: ["cert9.db"] },
      nss: { [userDb]: [{ pem: CURRENT_CA_PEM, flags: ",," }] },
    });
    expect(await nss(host)).toEqual({
      status: "done",
      databases: [{ dbDir: userDb, status: "trust_set" }],
    });
    expect(state.nss.get(userDb)?.[0]?.flags).toBe("C,,");
  });

  test("same bytes, trust cannot be set: reported as failed", async () => {
    const { host } = createFakeHost({
      commands: ["certutil"],
      dirs: { [userDb]: ["cert9.db"] },
      nss: { [userDb]: [{ pem: CURRENT_CA_PEM, flags: ",," }] },
      failCertutil: "-M",
    });
    expect(await nss(host)).toMatchObject({
      databases: [{ dbDir: userDb, status: "failed" }],
    });
  });

  test("already trusted is left alone; older CAs under the nickname are replaced", async () => {
    const { host, state } = createFakeHost({
      commands: ["certutil"],
      dirs: {
        [userDb]: ["cert9.db"],
        [firefoxRoot]: ["p"],
        [`${firefoxRoot}/p`]: ["cert9.db"],
      },
      nss: {
        [userDb]: [{ pem: CURRENT_CA_PEM, flags: "C,," }],
        [`${firefoxRoot}/p`]: [
          { pem: OLD_CA_PEM, flags: "C,," },
          { pem: UNRELATED_CA_PEM, flags: "C,," },
        ],
      },
    });
    expect(await nss(host)).toEqual({
      status: "done",
      databases: [
        { dbDir: userDb, status: "trusted" },
        { dbDir: `${firefoxRoot}/p`, status: "replaced" },
      ],
    });
    expect(state.nss.get(`${firefoxRoot}/p`)).toEqual([
      { pem: CURRENT_CA_PEM, flags: "C,," },
    ]);
  });

  test("finds XDG, snap and Flatpak Firefox profiles and sandboxed Chromium dbs", async () => {
    const xdgRoot = `${HOME}/.config/mozilla/firefox`;
    const flatpakRoot = `${HOME}/.var/app/org.mozilla.firefox/.mozilla/firefox`;
    const snapChromium = `${HOME}/snap/chromium/current/.pki/nssdb`;
    const snapResolved = `${HOME}/snap/chromium/2905/.pki/nssdb`;
    const { host } = createFakeHost({
      commands: ["certutil"],
      // snap's `current` is a symlink to the revision; it stays in $HOME.
      links: {
        [`${HOME}/snap/chromium/current`]: `${HOME}/snap/chromium/2905`,
      },
      dirs: {
        [userDb]: ["cert9.db"],
        [snapResolved]: ["cert9.db"],
        [`${HOME}/.var/app`]: ["org.mozilla.firefox", "org.example.NoDb"],
        [xdgRoot]: ["x.default"],
        [`${xdgRoot}/x.default`]: ["cert9.db"],
        [flatpakRoot]: ["f.default"],
        [`${flatpakRoot}/f.default`]: ["cert9.db"],
      },
    });
    const outcome = await nss(host);
    expect(outcome.status).toBe("done");
    if (outcome.status === "done") {
      expect(outcome.databases).toEqual([
        { dbDir: userDb, status: "added" },
        { dbDir: snapChromium, status: "added" },
        { dbDir: `${xdgRoot}/x.default`, status: "added" },
        { dbDir: `${flatpakRoot}/f.default`, status: "added" },
      ]);
    }
  });

  test("a profile linked outside the home directory is refused (finding 2)", async () => {
    const shared = "/srv/shared/profile";
    const { host, state } = createFakeHost({
      commands: ["certutil"],
      links: { [`${firefoxRoot}/evil`]: shared },
      dirs: {
        [userDb]: ["cert9.db"],
        [firefoxRoot]: ["evil"],
        [shared]: ["cert9.db"],
      },
    });
    expect(await nss(host)).toMatchObject({
      databases: [
        { dbDir: userDb, status: "added" },
        { dbDir: `${firefoxRoot}/evil`, status: "refused" },
      ],
    });
    expect(state.nss.has(shared)).toBe(false);
  });

  test.each([
    ["cert9.db", "/srv/shared-browser/cert9.db"],
    ["key4.db", "/srv/shared-browser/key4.db"],
  ] as const)("a %s link that leaves the database directory is refused", async (name, target) => {
    const dir = `${firefoxRoot}/p`;
    const { host, state } = createFakeHost({
      commands: ["certutil"],
      links: { [`${dir}/${name}`]: target },
      dirs: {
        [userDb]: ["cert9.db"],
        [firefoxRoot]: ["p"],
        [dir]: ["cert9.db", "key4.db"],
        "/srv/shared-browser": ["cert9.db", "key4.db"],
      },
    });
    expect(await nss(host)).toMatchObject({
      databases: [
        { dbDir: userDb, status: "added" },
        { dbDir: dir, status: "refused" },
      ],
    });
    expect(state.nss.has(dir)).toBe(false);
  });

  test("a dangling key4.db link is refused before initialization", async () => {
    const { host, state } = createFakeHost({
      commands: ["certutil"],
      dirs: { [userDb]: ["key4.db"] },
    });
    const inspect = host.inspectPath;
    const outcome = await nss({
      ...host,
      inspectPath: async (path) =>
        path === `${userDb}/key4.db`
          ? {
              realPath: path,
              isDirectory: false,
              isFile: false,
              uid: UID,
              mode: 0o12_0777,
              identity: "link",
            }
          : inspect(path),
    });
    expect(outcome).toMatchObject({ databases: [{ status: "refused" }] });
    expect(state.execs).toEqual([]);
  });

  test("a writable ancestor refuses the database", async () => {
    const { host, state } = createFakeHost({
      commands: ["certutil"],
      dirs: { [userDb]: ["cert9.db"] },
      meta: { [`${HOME}/.pki`]: { uid: UID, mode: 0o4_0777 } },
    });
    expect(await nss(host)).toMatchObject({
      databases: [{ status: "refused" }],
    });
    expect(state.execs).toEqual([]);
  });

  test.each([
    "directory",
    "ancestor",
  ])("replacement of a %s after export stops all writes", async (which) => {
    const { host, state } = createFakeHost({
      commands: ["certutil"],
      dirs: { [userDb]: ["cert9.db"] },
    });
    const execute = host.exec;
    const outcome = await nss({
      ...host,
      exec: async (argv, input) => {
        const result = await execute(argv, input);
        state.identities.set(
          which === "directory" ? userDb : `${HOME}/.pki`,
          "replaced"
        );
        return result;
      },
    });
    expect(outcome).toMatchObject({ databases: [{ status: "failed" }] });
    expect(
      state.execs.some((a) => ["-A", "-M", "-D"].includes(a[3] ?? ""))
    ).toBe(false);
  });

  test("an import that stores different bytes fails readback", async () => {
    const { host, state } = createFakeHost({
      commands: ["certutil"],
      dirs: { [userDb]: ["cert9.db"] },
    });
    const execute = host.exec;
    expect(
      await nss({
        ...host,
        exec: async (argv, input) => {
          const result = await execute(argv, input);
          if (argv[3] === "-A") {
            state.nss.set(userDb, [{ pem: OLD_CA_PEM, flags: "C,," }]);
          }
          return result;
        },
      })
    ).toMatchObject({
      databases: [
        {
          status: "failed",
          reason: "stored certificate differs from the validated CA",
        },
      ],
    });
  });

  test.each([
    ["another user's directory", { uid: 1001, mode: 0o4_0700 }, "dir"],
    ["a group-writable directory", { uid: UID, mode: 0o4_0770 }, "dir"],
    ["another user's cert9.db", { uid: 1001, mode: 0o10_0600 }, "db"],
  ] as const)("refuses %s (finding 2)", async (_label, meta, which) => {
    const dir = `${firefoxRoot}/p`;
    const { host, state } = createFakeHost({
      commands: ["certutil"],
      dirs: {
        [userDb]: ["cert9.db"],
        [firefoxRoot]: ["p"],
        [dir]: ["cert9.db"],
      },
      meta: { [which === "dir" ? dir : `${dir}/cert9.db`]: meta },
    });
    expect(await nss(host)).toMatchObject({
      databases: [
        { dbDir: userDb, status: "added" },
        { dbDir: dir, status: "refused" },
      ],
    });
    expect(state.nss.has(dir)).toBe(false);
  });
});

describe("real host boundary (finding 6)", () => {
  test("dangling database links remain visible and cannot pass as files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hack-trust-link-"));
    try {
      const link = join(dir, "key4.db");
      await symlink(join(dir, "missing.db"), link);
      const host = createLinuxTrustHost({ homeDir: dir });
      expect(await host.inspectPath(link)).toMatchObject({
        isFile: false,
        isDirectory: false,
      });
      await writeFile(join(dir, "missing.db"), "db");
      expect(await host.inspectPath(link)).toMatchObject({ isFile: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("resolveExecutable returns an executable absolute path and skips others", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hack-linux-trust-bin-"));
    try {
      expect(await resolveExecutable("hack-test-no-such-tool", dir)).toBeNull();
      await writeFile(join(dir, "hack-test-tool"), "#!/bin/sh\nexit 0\n");
      await chmod(join(dir, "hack-test-tool"), 0o644);
      // Present but not executable: skipped.
      expect(await resolveExecutable("hack-test-tool", dir)).toBeNull();
      await chmod(join(dir, "hack-test-tool"), 0o755);
      expect(await resolveExecutable("hack-test-tool", dir)).toBe(
        join(dir, "hack-test-tool")
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a spawn failure is an exit code, not a throw", async () => {
    const host = createLinuxTrustHost({ homeDir: "/nonexistent-home" });
    expect(await host.exec(["/nonexistent/hack-test-certutil", "-L"])).toEqual({
      exitCode: 127,
      stdout: "",
    });
  });
});

describe("configureLinuxSystemAndBrowserTrust (finding 1)", () => {
  const exportPath = `${HOME}/.hack/caddy/pki/caddy-local-authority.crt`;
  const current: CaddyCaIdentity = {
    state: "current",
    message: "current",
    currentPem: CURRENT_CA_PEM,
  };

  async function runCommand(opts: {
    readonly exported: string;
    readonly identity: CaddyCaIdentity;
    readonly canPrompt?: boolean;
    readonly afterValidate?: (state: FakeState) => void;
    readonly failSystem?: boolean;
  }) {
    const { configureLinuxSystemAndBrowserTrust } = await import(
      "../src/commands/global-linux-trust.ts"
    );
    const { host, state } = createFakeHost({
      commands: ["update-ca-certificates", "certutil"],
      dirs: { [`${HOME}/.pki/nssdb`]: ["cert9.db"] },
    });
    state.files.delete(STAGED);
    state.files.set(exportPath, opts.exported);
    const prompts: string[] = [];
    const { ok } = await configureLinuxSystemAndBrowserTrust({
      certPath: exportPath,
      composeFile: `${HOME}/.hack/caddy/docker-compose.yml`,
      deps: {
        host: opts.failSystem
          ? { ...host, runPrivileged: async () => 1 }
          : host,
        readFile: async (path) => state.files.get(path) ?? null,
        inspectIdentity: async () => {
          opts.afterValidate?.(state);
          return opts.identity;
        },
        canPrompt: () => opts.canPrompt ?? true,
        confirm: async (message) => {
          prompts.push(message);
          return true;
        },
      },
    });
    return { ok, state, prompts };
  }

  test("a valid export matching the running Caddy root is trusted; the prompt shows its fingerprint", async () => {
    const run = await runCommand({
      exported: CURRENT_CA_PEM,
      identity: current,
    });
    expect(run.ok).toBe(true);
    expect(run.prompts).toHaveLength(1);
    expect(run.prompts[0]).toContain(
      new X509Certificate(CURRENT_CA_PEM).fingerprint256
    );
  });

  test("system failure stops before any NSS command", async () => {
    const run = await runCommand({
      exported: CURRENT_CA_PEM,
      identity: current,
      failSystem: true,
    });
    expect(run.ok).toBe(false);
    expect(run.state.execs).toEqual([]);
    expect(run.state.nss.size).toBe(0);
  });

  test("the export changing after inspection does not change what is installed", async () => {
    const run = await runCommand({
      exported: CURRENT_CA_PEM,
      identity: current,
      afterValidate: (state) => state.files.set(exportPath, OLD_CA_PEM),
    });
    expect(run.ok).toBe(true);
    expect(
      run.state.files.get("anchor:/etc/ssl/certs/ca-certificates.crt")
    ).toBe(CURRENT_CA_PEM);
    expect(run.state.nss.get(`${HOME}/.pki/nssdb`)?.[0]?.pem).toBe(
      CURRENT_CA_PEM
    );
  });

  const unavailable: CaddyCaIdentity = {
    state: "unavailable",
    message: "unavailable",
  };

  test.each([
    ["a stale export (Caddy rotated its root)", OLD_CA_PEM, current],
    [
      "an export Hack cannot confirm (Docker unavailable)",
      CURRENT_CA_PEM,
      unavailable,
    ],
    ["a foreign CA", UNRELATED_CA_PEM, current],
    ["a non-CA certificate", NON_CA_LEAF_PEM, current],
    ["two certificates", `${CURRENT_CA_PEM}\n${OLD_CA_PEM}`, current],
  ])("refuses %s before any prompt or write", async (_label, exported, identity) => {
    const run = await runCommand({ exported, identity });
    expect(run.ok).toBe(false);
    expect(run.prompts).toEqual([]);
    expect(run.state.privileged).toEqual([]);
    expect(run.state.execs).toEqual([]);
  });

  test("non-interactive never runs a root command", async () => {
    const run = await runCommand({
      exported: CURRENT_CA_PEM,
      identity: current,
      canPrompt: false,
    });
    expect(run.prompts).toEqual([]);
    expect(run.state.privileged).toEqual([]);
  });
});
