import { Buffer } from "node:buffer";
import { X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertAutostartPathAclsTrusted } from "./autostart-path-acl.ts";
import { HackCliError } from "./cli-result.ts";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { isRecord } from "./guards.ts";
import { walkReplaceableChain } from "./path-trust.ts";

export interface AutostartTrustedBind {
  readonly source: string;
  readonly target: string;
  readonly readOnly: true;
}
const CERTIFICATES =
  /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g;
const MAX_CERTIFICATE_BYTES = 1024 * 1024;

/**
 * The only generated host mounts admitted at login are the two public TLS trust
 * inputs at fixed container destinations. No arbitrary file or executable is
 * admitted through this exception, and no trust material is changed here.
 */
export async function resolveAutostartTrustedTlsBinds(
  opts: { readonly hackHome?: string } = {}
): Promise<readonly AutostartTrustedBind[]> {
  try {
    const root = opts.hackHome ?? resolveGlobalHackDir();
    const pki = resolve(root, "caddy", "pki");
    const ca = resolve(pki, "caddy-local-authority.crt");
    if (!(await authenticateCertificates(ca))) {
      return [];
    }
    const mounts: AutostartTrustedBind[] = [
      {
        source: ca,
        target: "/etc/hack/ca/caddy-local-authority.crt",
        readOnly: true,
      },
    ];
    const bundle = resolve(pki, "caddy-host-trust-bundle.pem");
    if (await authenticateCertificates(bundle)) {
      mounts.push({
        source: bundle,
        target: "/etc/hack/ca/trust-bundle.pem",
        readOnly: true,
      });
    }
    return mounts;
  } catch {
    throw new HackCliError({
      code: "E_PERMISSION",
      message:
        "Automatic startup refused unsafe generated TLS mount inputs. Review the installed trust files or start manually. Values omitted.",
      detail: { reason: "compose_inputs_require_manual_start" },
    });
  }
}

async function authenticateCertificates(path: string): Promise<boolean> {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("Unavailable owner");
  }
  const checked = new Set<string>();
  const parent = walkReplaceableChain({
    path: dirname(path),
    uid,
    hackHome: null,
    allowMissing: true,
    checked,
  });
  if ("error" in parent) {
    throw new Error("Unsafe certificate parent");
  }
  if (!parent.complete) {
    return false;
  }
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  ).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (file === null) {
    return false;
  }
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      (before.uid !== uid && before.uid !== 0) ||
      (before.mode & 0o022) !== 0 ||
      (before.mode & 0o004) === 0 ||
      before.size > MAX_CERTIFICATE_BYTES
    ) {
      throw new Error("Unsafe certificate file");
    }
    checked.add(path);
    await assertAutostartPathAclsTrusted(checked);
    const bytes = new Uint8Array(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(
        bytes,
        length,
        bytes.length - length,
        length
      );
      if (result.bytesRead === 0) {
        break;
      }
      length += result.bytesRead;
    }
    const after = await file.stat();
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.mode !== before.mode ||
      after.uid !== before.uid
    ) {
      throw new Error("Certificate changed");
    }
    const text = Buffer.from(bytes.subarray(0, length)).toString("utf8");
    const certificates = [...text.matchAll(CERTIFICATES)];
    if (
      certificates.length === 0 ||
      certificates.length > 512 ||
      text.replace(CERTIFICATES, "").trim() !== ""
    ) {
      throw new Error("Unsupported certificate content");
    }
    for (const [pem] of certificates) {
      if (!new X509Certificate(pem).ca) {
        throw new Error("Not a CA certificate");
      }
    }
    return true;
  } finally {
    await file.close();
  }
}
