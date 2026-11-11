import { describe, expect, test } from "bun:test";

import {
  bundleContainsCertificate,
  detectLinuxDistroFamily,
  LINUX_ANCHOR_FILENAME,
  linuxSystemTrustCommands,
  NSS_CA_NICKNAME,
} from "../src/lib/linux-trust.ts";
import {
  applyLinuxNssTrust,
  applyLinuxSystemTrust,
  type LinuxTrustHost,
} from "../src/lib/linux-trust-setup.ts";

const HOME = "/fake-home";
const CERT_PATH = "/fake-home/.hack/caddy/pki/caddy-local-authority.crt";
const CERT =
  "-----BEGIN CERTIFICATE-----\nQUJDREVG\nR0hJSg==\n-----END CERTIFICATE-----\n";
const OLD_CERT =
  "-----BEGIN CERTIFICATE-----\nT0xET0xE\n-----END CERTIFICATE-----\n";
const PUBLIC_ROOT =
  "-----BEGIN CERTIFICATE-----\nUFVCTElD\n-----END CERTIFICATE-----\n";

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

type FakeState = {
  files: Map<string, string>;
  dirs: Map<string, string[]>;
  commands: Set<string>;
  privileged: string[][];
  execs: string[][];
  nss: Map<string, string>;
  failPrivileged?: string;
};

function createFakeHost(init: {
  readonly osRelease: string | null;
  readonly files?: Record<string, string>;
  readonly dirs?: Record<string, string[]>;
  readonly commands?: readonly string[];
  readonly nss?: Record<string, string>;
  readonly failPrivileged?: string;
}): { host: LinuxTrustHost; state: FakeState } {
  const files = new Map(Object.entries(init.files ?? {}));
  files.set(CERT_PATH, CERT);
  if (init.osRelease !== null) {
    files.set("/etc/os-release", init.osRelease);
  }
  const state: FakeState = {
    files,
    dirs: new Map(Object.entries(init.dirs ?? {})),
    commands: new Set(init.commands ?? []),
    privileged: [],
    execs: [],
    nss: new Map(Object.entries(init.nss ?? {})),
    failPrivileged: init.failPrivileged,
  };
  /** Simulated refresh: the family bundle gains every installed anchor. */
  const refresh = (bundle: string) => {
    state.files.set(
      bundle,
      `${PUBLIC_ROOT}${state.files.get(`anchor:${bundle}`) ?? ""}`
    );
  };
  const host: LinuxTrustHost = {
    homeDir: HOME,
    configHome: `${HOME}/.config`,
    readFile: async (path) => state.files.get(path) ?? null,
    listDir: async (path) => state.dirs.get(path) ?? [],
    hasCommand: async (name) => state.commands.has(name),
    exec: async (argv) => {
      state.execs.push([...argv]);
      const db = (argv[2] ?? "").replace(/^sql:/, "");
      const op = argv[3];
      if (op === "-N") {
        state.dirs.set(db, ["cert9.db", "key4.db"]);
        return { exitCode: 0, stdout: "" };
      }
      if (op === "-L") {
        const pem = state.nss.get(db);
        return pem
          ? { exitCode: 0, stdout: pem }
          : { exitCode: 255, stdout: "" };
      }
      if (op === "-D") {
        state.nss.delete(db);
        return { exitCode: 0, stdout: "" };
      }
      if (op === "-A") {
        if (state.nss.has(db)) {
          return { exitCode: 255, stdout: "" };
        }
        state.nss.set(db, state.files.get(argv.at(-1) ?? "") ?? "");
        return { exitCode: 0, stdout: "" };
      }
      return { exitCode: 1, stdout: "" };
    },
    runPrivileged: async (argv) => {
      state.privileged.push([...argv]);
      if (state.failPrivileged && argv[0] === state.failPrivileged) {
        return 1;
      }
      const [verb] = argv;
      if (verb === "install") {
        // Record the anchor against the bundle its family refresh extracts.
        const target = argv.at(-1) ?? "";
        const bundle = target.startsWith("/usr/local/share")
          ? "/etc/ssl/certs/ca-certificates.crt"
          : target.startsWith("/etc/pki/ca-trust")
            ? "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem"
            : "/var/lib/ca-certificates/ca-bundle.pem";
        state.files.set(`anchor:${bundle}`, CERT);
      } else if (verb === "update-ca-certificates") {
        refresh("/etc/ssl/certs/ca-certificates.crt");
        refresh("/var/lib/ca-certificates/ca-bundle.pem");
      } else if (verb === "update-ca-trust") {
        refresh("/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem");
      } else if (verb === "trust") {
        state.files.set("anchor:/etc/ssl/certs/ca-certificates.crt", CERT);
        refresh("/etc/ssl/certs/ca-certificates.crt");
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

describe("system trust commands", () => {
  test("each family gets its own anchor location and refresh step", () => {
    expect(
      linuxSystemTrustCommands({ family: "debian", certPath: CERT_PATH })
    ).toEqual([
      [
        "install",
        "-D",
        "-o",
        "root",
        "-g",
        "root",
        "-m",
        "0644",
        CERT_PATH,
        `/usr/local/share/ca-certificates/${LINUX_ANCHOR_FILENAME}`,
      ],
      ["update-ca-certificates"],
    ]);
    expect(
      linuxSystemTrustCommands({ family: "fedora", certPath: CERT_PATH }).at(-1)
    ).toEqual(["update-ca-trust", "extract"]);
    expect(
      linuxSystemTrustCommands({ family: "arch", certPath: CERT_PATH })
    ).toEqual([["trust", "anchor", "--store", CERT_PATH]]);
  });

  test("bundle matching ignores PEM line wrapping", () => {
    const rewrapped =
      "-----BEGIN CERTIFICATE-----\nQUJDREVGR0hJSg==\n-----END CERTIFICATE-----";
    expect(
      bundleContainsCertificate({
        bundle: `${PUBLIC_ROOT}${rewrapped}`,
        certPem: CERT,
      })
    ).toBe(true);
    expect(
      bundleContainsCertificate({ bundle: PUBLIC_ROOT, certPem: CERT })
    ).toBe(false);
  });
});

describe("applyLinuxSystemTrust", () => {
  test.each([
    ["ubuntu", "update-ca-certificates"],
    ["fedora", "update-ca-trust"],
    ["arch", "trust"],
    ["opensuse", "update-ca-certificates"],
  ] as const)("%s: confirmed run trusts the CA", async (name, tool) => {
    const { host, state } = createFakeHost({
      osRelease: OS_RELEASE[name],
      commands: [tool],
    });
    let shown = 0;
    const outcome = await applyLinuxSystemTrust({
      host,
      certPath: CERT_PATH,
      canPrompt: true,
      show: () => {
        shown += 1;
      },
      confirm: yes,
    });
    expect(outcome.status).toBe("trusted");
    expect(shown).toBe(1);
    expect(state.privileged.length).toBeGreaterThan(0);
  });

  test("already trusted: no prompt, nothing runs", async () => {
    const { host, state } = createFakeHost({
      osRelease: OS_RELEASE.ubuntu,
      commands: ["update-ca-certificates"],
      files: { "/etc/ssl/certs/ca-certificates.crt": `${PUBLIC_ROOT}${CERT}` },
    });
    const outcome = await applyLinuxSystemTrust({
      host,
      certPath: CERT_PATH,
      canPrompt: true,
      show: () => {
        throw new Error("no plan expected");
      },
      confirm: async () => {
        throw new Error("no prompt expected");
      },
    });
    expect(outcome).toEqual({ status: "trusted", family: "debian" });
    expect(state.privileged).toEqual([]);
  });

  test("non-interactive returns the commands with a stable code and runs nothing", async () => {
    const { host, state } = createFakeHost({
      osRelease: OS_RELEASE.fedora,
      commands: ["update-ca-trust"],
    });
    const outcome = await applyLinuxSystemTrust({
      host,
      certPath: CERT_PATH,
      canPrompt: false,
      show: noShow,
      confirm: async () => {
        throw new Error("must not prompt");
      },
    });
    expect(outcome).toMatchObject({
      status: "pending",
      code: "linux_trust_system_pending",
      family: "fedora",
    });
    expect(state.privileged).toEqual([]);
  });

  test("declined is pending", async () => {
    const { host, state } = createFakeHost({
      osRelease: OS_RELEASE.ubuntu,
      commands: ["update-ca-certificates"],
    });
    const outcome = await applyLinuxSystemTrust({
      host,
      certPath: CERT_PATH,
      canPrompt: true,
      show: noShow,
      confirm: async () => false,
    });
    expect(outcome.status).toBe("pending");
    expect(state.privileged).toEqual([]);
  });

  test("unknown distro and missing tool give manual steps", async () => {
    const unknown = createFakeHost({ osRelease: OS_RELEASE.alpine });
    const a = await applyLinuxSystemTrust({
      host: unknown.host,
      certPath: CERT_PATH,
      canPrompt: true,
      show: noShow,
      confirm: yes,
    });
    expect(a).toMatchObject({
      status: "manual",
      code: "linux_trust_distro_unknown",
    });

    const missing = createFakeHost({ osRelease: OS_RELEASE.arch });
    const b = await applyLinuxSystemTrust({
      host: missing.host,
      certPath: CERT_PATH,
      canPrompt: true,
      show: noShow,
      confirm: yes,
    });
    expect(b).toMatchObject({
      status: "manual",
      code: "linux_trust_tool_missing",
    });
    expect(missing.state.privileged).toEqual([]);
  });

  test("a failing root step stops and reports it", async () => {
    const { host, state } = createFakeHost({
      osRelease: OS_RELEASE.ubuntu,
      commands: ["update-ca-certificates"],
      failPrivileged: "install",
    });
    const outcome = await applyLinuxSystemTrust({
      host,
      certPath: CERT_PATH,
      canPrompt: true,
      show: noShow,
      confirm: yes,
    });
    expect(outcome).toMatchObject({ status: "failed", exitCode: 1 });
    expect(state.privileged).toHaveLength(1);
  });
});

describe("applyLinuxNssTrust", () => {
  const userDb = `${HOME}/.pki/nssdb`;
  const firefoxRoot = `${HOME}/.mozilla/firefox`;
  const profile = `${firefoxRoot}/abcd.default-release`;

  test("certutil missing is reported with the package to install", async () => {
    const { host } = createFakeHost({ osRelease: OS_RELEASE.ubuntu });
    const outcome = await applyLinuxNssTrust({ host, certPath: CERT_PATH });
    expect(outcome.status).toBe("certutil_missing");
    if (outcome.status === "certutil_missing") {
      expect(outcome.code).toBe("linux_trust_nss_certutil_missing");
      expect(outcome.hint).toContain("libnss3-tools");
    }
  });

  test("creates the user db, adds to it and to each Firefox profile, without root", async () => {
    const { host, state } = createFakeHost({
      osRelease: OS_RELEASE.fedora,
      commands: ["certutil"],
      dirs: {
        [firefoxRoot]: ["abcd.default-release", "profiles.ini"],
        [profile]: ["cert9.db", "key4.db"],
      },
    });
    const outcome = await applyLinuxNssTrust({ host, certPath: CERT_PATH });
    expect(outcome).toEqual({
      status: "done",
      databases: [
        { dbDir: userDb, status: "added" },
        { dbDir: profile, status: "added" },
      ],
    });
    expect(state.privileged).toEqual([]);
    expect(state.execs[0]).toEqual([
      "certutil",
      "-d",
      `sql:${userDb}`,
      "-N",
      "--empty-password",
    ]);
    expect(
      state.execs.filter((argv) => argv[3] === "-A").map((argv) => argv[7])
    ).toEqual([NSS_CA_NICKNAME, NSS_CA_NICKNAME]);
  });

  test("finds XDG, snap and Flatpak Firefox profiles and sandboxed Chromium dbs", async () => {
    const xdgRoot = `${HOME}/.config/mozilla/firefox`;
    const flatpakRoot = `${HOME}/.var/app/org.mozilla.firefox/.mozilla/firefox`;
    const snapChromium = `${HOME}/snap/chromium/current/.pki/nssdb`;
    const { host } = createFakeHost({
      osRelease: OS_RELEASE.ubuntu,
      commands: ["certutil"],
      dirs: {
        [userDb]: ["cert9.db"],
        [snapChromium]: ["cert9.db"],
        [`${HOME}/.var/app`]: ["org.mozilla.firefox", "org.example.NoDb"],
        [xdgRoot]: ["x.default"],
        [`${xdgRoot}/x.default`]: ["cert9.db"],
        [flatpakRoot]: ["f.default"],
        [`${flatpakRoot}/f.default`]: ["cert9.db"],
      },
    });
    const outcome = await applyLinuxNssTrust({ host, certPath: CERT_PATH });
    expect(outcome.status).toBe("done");
    if (outcome.status === "done") {
      expect(outcome.databases.map((db) => db.dbDir)).toEqual([
        userDb,
        snapChromium,
        `${xdgRoot}/x.default`,
        `${flatpakRoot}/f.default`,
      ]);
    }
  });

  test("already present is left alone; an old CA under the nickname is replaced", async () => {
    const { host, state } = createFakeHost({
      osRelease: OS_RELEASE.ubuntu,
      commands: ["certutil"],
      dirs: {
        [userDb]: ["cert9.db"],
        [firefoxRoot]: ["p"],
        [`${firefoxRoot}/p`]: ["cert9.db"],
      },
      nss: { [userDb]: CERT, [`${firefoxRoot}/p`]: OLD_CERT },
    });
    const outcome = await applyLinuxNssTrust({ host, certPath: CERT_PATH });
    expect(outcome).toEqual({
      status: "done",
      databases: [
        { dbDir: userDb, status: "trusted" },
        { dbDir: `${firefoxRoot}/p`, status: "replaced" },
      ],
    });
    expect(state.nss.get(`${firefoxRoot}/p`)).toBe(CERT);
  });
});
