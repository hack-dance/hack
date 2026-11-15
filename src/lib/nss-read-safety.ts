/**
 * Admission for observe-only NSS queries. Ownership alone does not make a
 * module configuration safe: NSS may load PKCS#11 code while opening a db.
 * This reader admits only a bounded, single built-in module configuration.
 * It never initializes, repairs, copies or queries a database itself.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  checkNssDbOwnership,
  compareNssDbSnapshot,
  type LinuxTrustHost,
} from "./linux-trust-setup.ts";

import { inspectNssReadPath } from "./nss-read-path.ts";

export const MAX_NSS_MODULE_BYTES = 16 * 1024;
const UNSUPPORTED_TEXT = /[^\x20-\x7e\n]/;
const MODULE_FILE = "pkcs11.txt";
const SIDECARS = [
  "cert9.db-wal",
  "cert9.db-shm",
  "cert9.db-journal",
  "key4.db-wal",
  "key4.db-shm",
  "key4.db-journal",
] as const;
/** SQL NSS can fall back to legacy module discovery; never admit that path. */
const LEGACY_FILES = ["secmod.db", "cert8.db", "key3.db"] as const;
/** Pinned upstream producer/fixture evidence: tests/fixtures/nss-read/README.md. */
const INTERNAL_NSS_LINES = [
  "NSS=trustOrder=75 cipherOrder=100 slotParams={0x00000001=[slotFlags=RSA,RC4,RC2,DES,DH,SHA1,MD5,MD2,SSL,TLS,AES,SHA256,SHA512,Camellia,SEED,ECC,RANDOM askpw=any timeout=30 ] }  Flags=internal,critical",
  "NSS=Flags=internal,critical slotparams=(1={slotFlags=[RSA,DSA,DH,RC2,RC4,DES,RANDOM,SHA1,MD5,MD2,SSL,TLS,AES,Camellia,SEED,SHA256,SHA512]})",
] as const;
const EMPTY_UPDATE_PARAMETERS =
  " updatedir='' updateCertPrefix='' updateKeyPrefix='' updateid='' updateTokenDescription=''";

type ReadText = (
  path: string,
  opts?: { readonly maxBytes?: number; readonly noFollow?: boolean }
) => Promise<{ readonly text: string } | "missing" | "unreadable">;

type DbSnapshot = Extract<
  Awaited<ReturnType<typeof checkNssDbOwnership>>,
  { readonly ok: true }
>["snapshot"];

export type NssReadSnapshot = {
  readonly database: DbSnapshot;
  readonly metadata: string;
};

export type NssReadCheck =
  | { readonly ok: true; readonly snapshot: NssReadSnapshot }
  | { readonly ok: false };

/**
 * A deliberately small subset of NSS's text grammar. No external library,
 * module DB, alternate directory/prefix, duplicate key, escaped token or
 * unknown option is accepted. Unsupported configurations are unknown; the
 * observer must never execute NSS to learn whether they are safe.
 */
export function hasOnlyInternalNssModule(opts: {
  readonly text: string;
  readonly dbPaths: readonly string[];
}): boolean {
  const { text } = opts;
  if (
    Buffer.byteLength(text) > MAX_NSS_MODULE_BYTES ||
    UNSUPPORTED_TEXT.test(text) ||
    text.includes("\\")
  ) {
    return false;
  }
  // Exact canonical templates, not a second implementation of NSS's quoting,
  // continuation, case folding, duplicate-key or nested parameter grammar.
  for (const path of opts.dbPaths) {
    if (
      path.includes("'") ||
      path.includes('"') ||
      path.includes("\n") ||
      path.includes("\\")
    ) {
      continue;
    }
    if (
      internalNssTemplates(path).some(
        (expected) =>
          text === expected ||
          text === `${expected}\n` ||
          text === `${expected}\n\n`
      )
    ) {
      return true;
    }
  }
  return false;
}

function internalNssTemplates(path: string): readonly string[] {
  const templates: string[] = [];
  for (const flags of ["", "optimizeSpace"]) {
    for (const updates of ["", EMPTY_UPDATE_PARAMETERS]) {
      for (const nss of INTERNAL_NSS_LINES) {
        for (const trailingSpace of ["", " "]) {
          const expected = [
            "library=",
            "name=NSS Internal PKCS #11 Module",
            `parameters=configdir='sql:${path}' certPrefix='' keyPrefix='' secmod='secmod.db' flags=${flags}${updates}${trailingSpace}`,
            nss,
          ].join("\n");
          templates.push(expected);
        }
      }
    }
  }
  return templates;
}

/**
 * Check database identities using the write guard from HACK-2137, then
 * module discovery and SQLite sidecars. Every required file must exist;
 * missing, unreadable and unsafe all refuse. Module bytes are pinned too,
 * since inode identity alone does not detect an in-place metadata edit.
 */
export async function checkNssReadSafety(opts: {
  readonly host: LinuxTrustHost;
  readonly dbDir: string;
  readonly readText: ReadText;
  readonly exists: (path: string) => Promise<boolean | "unknown">;
}): Promise<NssReadCheck> {
  try {
    const traversal = await inspectNssReadPath({
      host: opts.host,
      path: opts.dbDir,
    });
    if (traversal === null) {
      return { ok: false };
    }
    const checked = await checkNssDbOwnership({
      ...opts,
      requireDb: true,
      includePathAncestors: true,
    });
    if (!checked.ok || checked.snapshot.files["key4.db"] === null) {
      return { ok: false };
    }
    const dir = await opts.host.inspectPath(opts.dbDir);
    if (!dir?.isDirectory) {
      return { ok: false };
    }
    for (const name of [...LEGACY_FILES, ...SIDECARS]) {
      // A dangling link is also unsafe: inspectPath keeps it observable.
      if (
        (await opts.exists(join(dir.realPath, name))) !== false ||
        (await opts.host.inspectPath(join(dir.realPath, name))) !== null
      ) {
        return { ok: false };
      }
    }
    const modulePath = join(dir.realPath, MODULE_FILE);
    const present = await opts.exists(modulePath);
    const file = await opts.host.inspectPath(modulePath);
    if (
      present !== true ||
      !file?.isFile ||
      file.realPath !== modulePath ||
      file.uid !== opts.host.uid ||
      (file.mode & 0o022) !== 0
    ) {
      return { ok: false };
    }
    const read = await opts.readText(modulePath, {
      maxBytes: MAX_NSS_MODULE_BYTES,
      noFollow: true,
    });
    if (
      typeof read === "string" ||
      !hasOnlyInternalNssModule({
        text: read.text,
        dbPaths: [opts.dbDir, dir.realPath],
      })
    ) {
      return { ok: false };
    }
    const after = await opts.host.inspectPath(modulePath);
    if (
      !after?.isFile ||
      after.realPath !== modulePath ||
      after.uid !== opts.host.uid ||
      (after.mode & 0o022) !== 0 ||
      after.identity !== file.identity
    ) {
      return { ok: false };
    }
    return {
      ok: true,
      snapshot: {
        database: checked.snapshot,
        metadata: JSON.stringify([
          dir.realPath,
          traversal,
          file.identity,
          createHash("sha256").update(read.text).digest("hex"),
        ]),
      },
    };
  } catch {
    return { ok: false };
  }
}

/** No identities may be created or replaced during an observe-only query. */
export function sameNssReadSnapshot(opts: {
  readonly pinned: NssReadSnapshot;
  readonly current: NssReadSnapshot;
}): boolean {
  return (
    opts.pinned.metadata === opts.current.metadata &&
    compareNssDbSnapshot({
      pinned: opts.pinned.database,
      current: opts.current.database,
      created: false,
    }).ok
  );
}
