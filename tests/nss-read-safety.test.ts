import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type CaTrustDeps,
  inspectCaTrust,
  listDirOutcome,
  pathExistsOutcome,
  readTextOutcome,
} from "../src/lib/ca-trust-status.ts";
import type {
  LinuxTrustHost,
  ResolvedPathInfo,
} from "../src/lib/linux-trust-setup.ts";
import {
  hasOnlyInternalNssModule,
  MAX_NSS_MODULE_BYTES,
} from "../src/lib/nss-read-safety.ts";
import { vettedHelperEnv } from "../src/lib/vetted-env.ts";
import internalModuleFixture from "./fixtures/nss-read/upstream-internal.pkcs11.json";
import { CURRENT_CA_PEM } from "./helpers/ca-certificates.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const UPSTREAM_MODULE = internalModuleFixture.text;

function moduleText(dbDir: string, updates = true): string {
  const text = UPSTREAM_MODULE.replace("@DATABASE_DIR@", dbDir);
  return updates
    ? text
    : text.replace(
        " updatedir='' updateCertPrefix='' updateKeyPrefix='' updateid='' updateTokenDescription=''",
        ""
      );
}

/** Placeholder files only; no NSS binary, SQL database or module is loaded. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nss-read-"));
  roots.push(root);
  const home = join(root, "home");
  const db = join(home, ".pki", "nssdb");
  const config = join(home, ".config");
  const data = join(home, ".local", "share");
  await mkdir(db, { recursive: true, mode: 0o700 });
  await mkdir(config, { recursive: true, mode: 0o700 });
  await mkdir(data, { recursive: true, mode: 0o700 });
  for (const name of ["cert9.db", "key4.db"]) {
    await writeFile(
      join(db, name),
      "database placeholder; never opened by NSS",
      { mode: 0o600 }
    );
  }
  await writeFile(join(db, "pkcs11.txt"), moduleText(db), { mode: 0o600 });
  const uid = process.getuid?.() ?? 1000;
  const queries: (readonly string[])[] = [];
  const mutations: ((
    path: string,
    info: ResolvedPathInfo | null
  ) => ResolvedPathInfo | null)[] = [];
  const inspect = async (path: string): Promise<ResolvedPathInfo | null> => {
    if (!(path === root || path.startsWith(`${root}/`))) {
      // No owner-home reads: ancestors outside this fixture are synthetic.
      return {
        realPath: path,
        uid: 0,
        mode: 0o4_0755,
        isDirectory: true,
        isFile: false,
        identity: path,
      };
    }
    try {
      const entry = await lstat(path);
      const resolved = await realpath(path).catch(() => path);
      const info = await stat(resolved).catch(() => entry);
      return {
        realPath: resolved,
        uid: info.uid,
        mode: info.mode,
        isDirectory: info.isDirectory(),
        isFile: info.isFile() && !entry.isSymbolicLink(),
        identity: `${info.dev}:${info.ino}`,
      };
    } catch {
      return null;
    }
  };
  const never = async (): Promise<never> => {
    throw new Error("write/exec boundary must never be called");
  };
  const host: LinuxTrustHost = {
    homeDir: home,
    configHome: config,
    dataHome: data,
    uid,
    readFile: never,
    listDir: async (path) => {
      const entries = await listDirOutcome(path);
      return entries === "unknown" ? [] : entries;
    },
    inspectPath: async (path) => {
      let info = await inspect(path);
      for (const mutation of mutations) {
        info = mutation(path, info);
      }
      return info;
    },
    inspectEntry: async (path) => {
      if (!(path === root || path.startsWith(`${root}/`))) {
        return {
          uid: 0,
          mode: 0o4_0755,
          isDirectory: true,
          isSymbolicLink: false,
          identity: path,
        };
      }
      try {
        const info = await lstat(path);
        return {
          uid: info.uid,
          mode: info.mode,
          isDirectory: info.isDirectory(),
          isSymbolicLink: info.isSymbolicLink(),
          identity: `${info.dev}:${info.ino}`,
        };
      } catch {
        return null;
      }
    },
    readLink: async (path) => {
      if (!path.startsWith(`${root}/`)) {
        return null;
      }
      try {
        return await readlink(path);
      } catch {
        return null;
      }
    },
    makeDir: never,
    resolveSudo: never,
    exec: never,
    runPrivileged: never,
    resolveCommand: async (name) =>
      name === "certutil" ? "/usr/bin/certutil" : null,
  };
  const caPath = join(home, "ca-placeholder.pem");
  const deps: CaTrustDeps = {
    platform: "linux",
    caPath,
    linuxHost: host,
    readText: async (path, opts) =>
      path === caPath
        ? { text: CURRENT_CA_PEM }
        : path === "/etc/os-release"
          ? { text: "ID=debian\n" }
          : path === "/etc/ssl/certs/ca-certificates.crt"
            ? { text: CURRENT_CA_PEM }
            : await readTextOutcome(path, opts),
    exists: pathExistsOutcome,
    listDir: async (path) =>
      path === home || path.startsWith(`${home}/`)
        ? await listDirOutcome(path)
        : [],
    query: async (argv) => {
      queries.push(argv);
      return {
        exitCode: 0,
        stderr: "",
        stdout: argv.includes("-a")
          ? CURRENT_CA_PEM
          : "Hack Caddy Local CA   C,,\n",
      };
    },
    now: () => Date.parse("2027-01-01T00:00:00Z"),
  };
  return { root, home, db, host, deps, queries, mutations };
}

async function expectRefused(
  f: Awaited<ReturnType<typeof fixture>>,
  deps: CaTrustDeps = f.deps
) {
  const report = await inspectCaTrust(deps);
  expect(report.nss).toContainEqual(
    expect.objectContaining({ db: f.db, state: "unknown" })
  );
  expect(report.state).toBe("unknown");
  expect(f.queries).toEqual([]);
  expect(report.nss.find((entry) => entry.db === f.db)?.detail).not.toContain(
    f.home
  );
}

test("an owned built-in SQL profile is read in its selected context, without any write boundary", async () => {
  const f = await fixture();
  const before = await readdir(f.db);
  const report = await inspectCaTrust(f.deps);
  expect(report.state).toBe("trusted");
  expect(f.queries).toHaveLength(2);
  for (const query of f.queries) {
    expect(query.slice(0, 4)).toEqual([
      "/usr/bin/certutil",
      "-d",
      `sql:${f.db}`,
      "-L",
    ]);
    expect(query.some((arg) => ["-N", "-A", "-M", "-D"].includes(arg))).toBe(
      false
    );
  }
  expect(await readdir(f.db)).toEqual(before);
  expect(f.host.homeDir).toBe(f.home);
});

test.each([
  "directory",
  "ancestor",
  "cert9.db",
  "key4.db",
  "pkcs11.txt",
])("foreign owner or writable %s never reaches the query", async (part) => {
  for (const change of [{ uid: 1_234_567 }, { mode: 0o10_0666 }]) {
    const f = await fixture();
    const path =
      part === "directory"
        ? f.db
        : part === "ancestor"
          ? dirname(f.db)
          : join(f.db, part);
    f.mutations.push((candidate, info) =>
      candidate === path && info ? { ...info, ...change } : info
    );
    await expectRefused(f);
  }
});

test.each([
  "cert9.db",
  "key4.db",
  "pkcs11.txt",
  "cert9.db-wal",
  "key4.db-shm",
])("linked or dangling %s never reaches the query", async (name) => {
  for (const dangling of [false, true]) {
    const f = await fixture();
    const target = join(f.root, "module-placeholder");
    if (!dangling) {
      await writeFile(target, moduleText(f.db), { mode: 0o600 });
    }
    await rm(join(f.db, name), { force: true });
    await symlink(target, join(f.db, name));
    await expectRefused(f);
  }
});

test("a profile resolving outside selected roots is unknown without querying", async () => {
  const f = await fixture();
  const elsewhere = join(f.root, "other-profile");
  await rename(f.db, elsewhere);
  await symlink(elsewhere, f.db);
  await expectRefused(f);
});

test.each([
  "secmod.db",
  "cert8.db",
  "key3.db",
])("legacy %s never starts NSS discovery", async (name) => {
  const f = await fixture();
  await writeFile(join(f.db, name), "legacy module placeholder", {
    mode: 0o600,
  });
  await expectRefused(f);
});

test.each([
  "cert9.db",
  "key4.db",
  "pkcs11.txt",
])("missing %s is unknown, never initialized", async (name) => {
  const f = await fixture();
  await rm(join(f.db, name));
  await expectRefused(f);
});

test("unreadable, oversized or unprovable metadata is unknown without querying", async () => {
  const f = await fixture();
  for (const result of ["missing", "unreadable"] as const) {
    await expectRefused(f, {
      ...f.deps,
      readText: async (path, opts) =>
        path.endsWith("pkcs11.txt")
          ? result
          : await f.deps.readText(path, opts),
    });
  }
  await expectRefused(f, {
    ...f.deps,
    exists: async (path) =>
      path.endsWith("secmod.db") ? "unknown" : await f.deps.exists(path),
  });
  await writeFile(
    join(f.db, "pkcs11.txt"),
    "x".repeat(MAX_NSS_MODULE_BYTES + 1)
  );
  await expectRefused(f);
  expect(
    await readTextOutcome(join(f.db, "pkcs11.txt"), {
      maxBytes: MAX_NSS_MODULE_BYTES,
    })
  ).toBe("unreadable");
});

test.each([
  [
    "external library",
    (text: string) =>
      text.replace("library=", "library=/module-placeholder.so"),
  ],
  [
    "relative library",
    (text: string) => text.replace("library=", "library=module-placeholder.so"),
  ],
  [
    "case-folded duplicate key",
    (text: string) => `${text}Library=/module-placeholder.so\n`,
  ],
  [
    "alternate update directory",
    (text: string) =>
      text.replace("updatedir=''", "updatedir='/other-placeholder'"),
  ],
  [
    "nonempty flags",
    (text: string) => text.replace("flags= ", "flags=readOnly "),
  ],
  ["duplicate key", (text: string) => `${text}library=\n`],
  [
    "second module",
    (text: string) => `${text}\nlibrary=/module-placeholder.so\nname=other\n`,
  ],
  [
    "alternate config",
    (text: string) => text.replace("configdir=", "otherdir="),
  ],
  [
    "alternate module db",
    (text: string) =>
      text.replace("secmod='secmod.db'", "secmod='/module-placeholder'"),
  ],
  [
    "unknown NSS option",
    (text: string) =>
      text.replace(
        "Flags=internal,critical",
        "Flags=internal,critical,moduleDBOnly"
      ),
  ],
  [
    "unknown parameter",
    (text: string) =>
      text.replace("flags=", "moduleDB=/module-placeholder flags="),
  ],
  ["continuation", (text: string) => text.replace("library=", "library=\\\n")],
  ["NUL", (text: string) => `${text}\0`],
] as const)("unsupported %s never reaches NSS", async (_name, change) => {
  const f = await fixture();
  const text = change(moduleText(f.db));
  await writeFile(join(f.db, "pkcs11.txt"), text);
  expect(hasOnlyInternalNssModule({ text, dbPaths: [f.db] })).toBe(false);
  await expectRefused(f);
});

test.each([
  "cert9.db",
  "key4.db",
  "pkcs11.txt",
  "directory",
])("%s identity replaced between admission and first query prevents invocation", async (name) => {
  const f = await fixture();
  const path = name === "directory" ? f.db : join(f.db, name);
  let reads = 0;
  f.mutations.push((candidate, info) => {
    if (
      candidate === path &&
      info &&
      ++reads > (name === "pkcs11.txt" || name === "directory" ? 2 : 1)
    ) {
      return { ...info, identity: "replacement-placeholder" };
    }
    return info;
  });
  await expectRefused(f);
});

test("in-place module metadata edit between admission and query prevents invocation", async () => {
  const f = await fixture();
  let reads = 0;
  await expectRefused(f, {
    ...f.deps,
    readText: async (path, opts) => {
      const result = await f.deps.readText(path, opts);
      if (path.endsWith("pkcs11.txt") && ++reads > 1) {
        return { text: moduleText(f.db, false) };
      }
      return result;
    },
  });
});

test("replacement during a query discards the result and prevents the next query", async () => {
  const f = await fixture();
  const report = await inspectCaTrust({
    ...f.deps,
    query: async (argv, opts) => {
      const result = await f.deps.query(argv, opts);
      f.mutations.push((path, info) =>
        path === join(f.db, "cert9.db") && info
          ? { ...info, identity: "replacement-placeholder" }
          : info
      );
      return result;
    },
  });
  expect(report.state).toBe("unknown");
  expect(f.queries).toHaveLength(1);
});

test("stalled ownership inspection consumes the existing budget and cannot start a late query", async () => {
  const f = await fixture();
  const report = await inspectCaTrust({
    ...f.deps,
    now: Date.now,
    budgetMs: 30,
    linuxHost: {
      ...f.host,
      inspectPath: async () => await new Promise(() => undefined),
    },
  });
  expect(report.state).toBe("unknown");
  expect(f.queries).toEqual([]);
});

test.each([
  "cert9.db-wal",
  "cert9.db-shm",
  "cert9.db-journal",
  "key4.db-wal",
  "key4.db-shm",
  "key4.db-journal",
])("even an owned %s is unknown, avoiding journal recovery", async (name) => {
  const f = await fixture();
  await writeFile(join(f.db, name), "journal placeholder", { mode: 0o600 });
  await expectRefused(f);
});

test("the selected XDG shared database remains supported", async () => {
  const f = await fixture();
  const db = join(f.host.dataHome, "pki", "nssdb");
  await mkdir(dirname(db), { recursive: true, mode: 0o700 });
  await rename(f.db, db);
  await writeFile(join(db, "pkcs11.txt"), moduleText(db));
  const report = await inspectCaTrust(f.deps);
  expect(report.state).toBe("trusted");
  expect(f.queries).toHaveLength(2);
  expect(f.queries[0]?.[2]).toBe(`sql:${db}`);
});

test("a profile alias inside the selected home remains supported", async () => {
  const f = await fixture();
  const profiles = join(f.home, ".mozilla", "firefox");
  await mkdir(profiles, { recursive: true, mode: 0o700 });
  const alias = join(profiles, "profile-placeholder");
  await symlink(f.db, alias);
  const report = await inspectCaTrust(f.deps);
  expect(report.nss.find((entry) => entry.db === alias)?.state).toBe("trusted");
  expect(f.queries.some((query) => query[2] === `sql:${alias}`)).toBe(true);
});

test("the query environment keeps the selected HOME and removes NSS and loader selectors", () => {
  const selectors = [
    "NSS_DEFAULT_DB_TYPE",
    "NSS_SDB_USE_CACHE",
    "NSS_MODULE_PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
  ];
  const source = {
    HOME: "/selected-home-placeholder",
    ...Object.fromEntries(
      selectors.map((key) => [key, "selector-placeholder"])
    ),
  };
  const helper = vettedHelperEnv({ source });
  expect(helper.env.HOME).toBe(source.HOME);
  for (const key of selectors) {
    expect(helper.unsetEnvKeys).toContain(key);
    expect(helper.env[key]).toBeUndefined();
  }
});

test("a traversed writable directory cannot hide behind a safe resolved profile", async () => {
  const f = await fixture();
  const actual = join(f.home, "private-profile");
  await rename(f.db, actual);
  await writeFile(join(actual, "pkcs11.txt"), moduleText(actual));
  const shared = join(f.root, "shared-placeholder");
  await mkdir(join(shared, "firefox"), { recursive: true, mode: 0o700 });
  await symlink(shared, join(f.home, ".mozilla"));
  const alias = join(f.home, ".mozilla", "firefox", "profile-placeholder");
  await symlink(actual, alias);
  f.mutations.push((path, info) =>
    path === join(f.home, ".mozilla") && info
      ? { ...info, mode: 0o4_0777 }
      : info
  );
  const report = await inspectCaTrust(f.deps);
  expect(report.nss.find((entry) => entry.db === alias)?.state).toBe("unknown");
  expect(f.queries).toEqual([]);
});

test("oversized discovery is unknown and starts no profile query", async () => {
  const f = await fixture();
  await rm(f.db, { recursive: true });
  const profiles = join(f.home, ".mozilla", "firefox");
  const report = await inspectCaTrust({
    ...f.deps,
    listDir: async (path) =>
      path === profiles
        ? Array.from({ length: 257 }, (_value, i) => `profile-${i}`)
        : await f.deps.listDir(path),
  });
  expect(report.nss).toContainEqual(
    expect.objectContaining({ db: profiles, state: "unknown" })
  );
  expect(f.queries).toEqual([]);
});

test("legacy files without SQL databases remain unknown and are never migrated", async () => {
  const f = await fixture();
  await rm(join(f.db, "cert9.db"));
  await rm(join(f.db, "key4.db"));
  await writeFile(join(f.db, "cert8.db"), "legacy placeholder", {
    mode: 0o600,
  });
  await writeFile(join(f.db, "key3.db"), "legacy placeholder", { mode: 0o600 });
  await expectRefused(f);
});

test("an unlistable selected database is unknown without a query", async () => {
  const f = await fixture();
  await expectRefused(f, {
    ...f.deps,
    listDir: async (path) =>
      path === f.db ? "unknown" : await f.deps.listDir(path),
  });
});

test("the upstream golden and optimizeSpace producer variants remain readable", async () => {
  for (const optimize of [false, true]) {
    const f = await fixture();
    const text = optimize
      ? moduleText(f.db).replace("flags= ", "flags=optimizeSpace ")
      : moduleText(f.db);
    await writeFile(join(f.db, "pkcs11.txt"), text);
    const report = await inspectCaTrust(f.deps);
    expect(report.state).toBe("trusted");
    expect(f.queries).toHaveLength(2);
  }
});

test("nonblocking strict reads reject a FIFO without a writer, and no-follow refuses links", async () => {
  if (process.platform === "win32") {
    return;
  }
  const f = await fixture();
  const pipe = join(f.root, "fifo-placeholder");
  const created = Bun.spawnSync(["mkfifo", pipe]);
  expect(created.exitCode).toBe(0);
  const started = Date.now();
  expect(await readTextOutcome(pipe, { maxBytes: 32 })).toBe("unreadable");
  expect(Date.now() - started).toBeLessThan(1000);
  const alias = join(f.root, "metadata-link-placeholder");
  await symlink(join(f.db, "pkcs11.txt"), alias);
  expect(
    await readTextOutcome(alias, {
      maxBytes: MAX_NSS_MODULE_BYTES,
      noFollow: true,
    })
  ).toBe("unreadable");
  expect(
    await readTextOutcome(alias, { maxBytes: MAX_NSS_MODULE_BYTES })
  ).toEqual({ text: moduleText(f.db) });
});

test("the pinned NSS default internal-module source layout is admitted", async () => {
  const f = await fixture();
  // SECMOD_INT_FLAGS from the pinned upstream secmodt.h, not the guard's constants.
  const nss =
    "NSS=Flags=internal,critical slotparams=(1={slotFlags=[RSA,DSA,DH,RC2,RC4,DES,RANDOM,SHA1,MD5,MD2,SSL,TLS,AES,Camellia,SEED,SHA256,SHA512]})";
  const lines = moduleText(f.db).split("\n");
  lines[3] = nss;
  await writeFile(join(f.db, "pkcs11.txt"), lines.join("\n"));
  expect((await inspectCaTrust(f.deps)).state).toBe("trusted");
  expect(f.queries).toHaveLength(2);
});

test.each([
  false,
  true,
])("every intermediate symlink target is checked (writable: %s)", async (writable) => {
  const f = await fixture();
  const actual = join(f.home, "private-profile");
  await rename(f.db, actual);
  await writeFile(join(actual, "pkcs11.txt"), moduleText(actual));
  const shared = join(f.root, "bridge-parent-placeholder");
  await mkdir(shared, { mode: 0o700 });
  await symlink(actual, join(shared, "bridge"));
  await symlink(join(shared, "bridge"), f.db);
  if (writable) {
    await chmod(shared, 0o777);
  }
  const report = await inspectCaTrust(f.deps);
  expect(report.nss.find((entry) => entry.db === f.db)?.state).toBe(
    writable ? "unknown" : "trusted"
  );
  expect(f.queries).toHaveLength(writable ? 0 : 2);
});

test("changing an intermediate link identity prevents the next query", async () => {
  const f = await fixture();
  const actual = join(f.home, "private-profile");
  await rename(f.db, actual);
  await writeFile(join(actual, "pkcs11.txt"), moduleText(actual));
  const intermediate = join(f.root, "bridge-placeholder");
  await symlink(actual, intermediate);
  await symlink(intermediate, f.db);
  let reads = 0;
  const inspectEntry = f.host.inspectEntry;
  if (!inspectEntry) {
    throw new Error("fixture traversal seam missing");
  }
  await expectRefused(f, {
    ...f.deps,
    linuxHost: {
      ...f.host,
      inspectEntry: async (path) => {
        const info = await inspectEntry(path);
        return path === intermediate && info && ++reads > 1
          ? { ...info, identity: "replaced-intermediate-placeholder" }
          : info;
      },
    },
  });
});

test("a link loop is unknown and cannot start a query", async () => {
  const f = await fixture();
  // Discovery itself can no longer follow the selected db, but must still
  // report it unknown rather than infer that the selected store is healthy.
  await rm(f.db, { recursive: true });
  const bridge = join(f.root, "loop-placeholder");
  await symlink(f.db, bridge);
  await symlink(bridge, f.db);
  await expectRefused(f);
});
