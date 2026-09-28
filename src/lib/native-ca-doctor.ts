import { createHash, X509Certificate } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  inspectActiveNativeHttpsOwner,
  verifyActiveNativeHttpsConnection,
  verifyNativeHttpsHostname,
} from "../backends/native-project-https.ts";
import type { NativeRuntimeSelection } from "../backends/native-runtime-client.ts";
import { canPrompt, confirmSafe } from "./interactivity.ts";
import { checkMacCaTrust } from "./mac-ca-trust.ts";
import { run } from "./shell.ts";

type NativeCaOwner = Awaited<ReturnType<typeof inspectActiveNativeHttpsOwner>>;
type NativeCaTrust = Awaited<ReturnType<typeof checkMacCaTrust>>;

export interface NativeCaDoctorDependencies {
  readonly inspect: typeof inspectActiveNativeHttpsOwner;
  readonly trust: typeof checkMacCaTrust;
  readonly verify: typeof verifyNativeHttpsHostname;
  readonly verifyPeer: typeof verifyActiveNativeHttpsConnection;
  readonly promptAllowed: typeof canPrompt;
  readonly confirm: typeof confirmSafe;
  readonly runCommand: typeof run;
}

const DEFAULTS: NativeCaDoctorDependencies = {
  inspect: inspectActiveNativeHttpsOwner,
  trust: checkMacCaTrust,
  verify: verifyNativeHttpsHostname,
  verifyPeer: verifyActiveNativeHttpsConnection,
  promptAllowed: canPrompt,
  confirm: confirmSafe,
  runCommand: run,
};

function sameOwner(a: NativeCaOwner, b: NativeCaOwner): boolean {
  return (
    a.caPath === b.caPath &&
    a.caSha256 === b.caSha256 &&
    a.httpsPort === b.httpsPort &&
    a.listenerFingerprint === b.listenerFingerprint &&
    a.caddyPid === b.caddyPid &&
    a.caddyBinary === b.caddyBinary
  );
}

function uncertain(): Error {
  return new Error(
    "Native Caddy or its CA changed during trust verification; no further trust change was attempted."
  );
}

async function verifyRoute(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly owner: NativeCaOwner;
  readonly hostname: string;
  readonly dependencies: NativeCaDoctorDependencies;
}): Promise<void> {
  await opts.dependencies.verify(
    opts.hostname,
    opts.owner.httpsPort,
    opts.owner.caPath,
    "/",
    async (peerPort) => {
      await opts.dependencies.verifyPeer({
        runtime: opts.runtime,
        owner: opts.owner,
        peerPort,
      });
    }
  );
}

/** A trust result is current only if the live Caddy identity and root survive the keychain read. */
export async function inspectNativeCaTrust(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly hostname?: string;
  readonly dependencies?: Partial<NativeCaDoctorDependencies>;
}): Promise<{ readonly owner: NativeCaOwner; readonly trust: NativeCaTrust }> {
  const deps = { ...DEFAULTS, ...opts.dependencies };
  const before = await deps.inspect({ runtime: opts.runtime });
  if (opts.hostname) {
    await verifyRoute({
      runtime: opts.runtime,
      owner: before,
      hostname: opts.hostname,
      dependencies: deps,
    });
  }
  const trust = await deps.trust({ certPath: before.caPath });
  const after = await deps.inspect({ runtime: opts.runtime });
  if (!sameOwner(before, after)) {
    throw uncertain();
  }
  return { owner: after, trust };
}

/** Read the exact bounded public root through a non-following descriptor before sudo. */
async function readCurrentRoot(owner: NativeCaOwner): Promise<Buffer> {
  const file = await open(
    owner.caPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      before.size < 1 ||
      before.size > 65_536
    ) {
      throw uncertain();
    }
    const bytes = Buffer.alloc(before.size + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    if (
      bytesRead !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw uncertain();
    }
    const pem = bytes.subarray(0, bytesRead);
    const der = new X509Certificate(pem).raw;
    if (createHash("sha256").update(der).digest("hex") !== owner.caSha256) {
      throw uncertain();
    }
    return pem;
  } finally {
    await file.close();
  }
}

/** Require a fresh human confirmation and native sudo prompt; never trust a stale export. */
export async function repairNativeCaTrust(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly hostname?: string;
  readonly dependencies?: Partial<NativeCaDoctorDependencies>;
}): Promise<"already-trusted" | "installed" | "declined"> {
  if (!opts.hostname) {
    throw new Error(
      "Native trust repair requires a reviewed HTTPS hostname: run hack doctor --fix --browser-url https://your-app.hack.local."
    );
  }
  const deps = { ...DEFAULTS, ...opts.dependencies };
  const before = await inspectNativeCaTrust({ ...opts, dependencies: deps });
  if (!before.trust.installable) {
    throw new Error(
      before.trust.issue ?? "The live native Caddy root is not installable."
    );
  }
  if (before.trust.trusted) {
    return "already-trusted";
  }
  if (!deps.promptAllowed()) {
    return "declined";
  }
  const approved = await deps.confirm({
    message:
      "Trust this verified live native Caddy root in the macOS System keychain? (requires a native administrator prompt)",
    initialValue: false,
    nonInteractive: "decline",
  });
  if (!approved) {
    return "declined";
  }
  const confirmed = await deps.inspect({ runtime: opts.runtime });
  if (!sameOwner(before.owner, confirmed)) {
    throw uncertain();
  }
  const pem = await readCurrentRoot(confirmed);
  const directory = await mkdtemp(join(opts.runtime.home, "native-ca-trust-"));
  try {
    const staged = join(directory, "root.crt");
    const file = await open(
      staged,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600
    );
    try {
      await file.writeFile(pem);
      await file.sync();
    } finally {
      await file.close();
    }
    const prompted = await deps.runCommand(["sudo", "-v"], {
      stdin: "inherit",
      timeoutMs: 120_000,
      forwardSignals: true,
    });
    if (prompted !== 0) {
      throw new Error("Native administrator authorization was not completed.");
    }
    const afterPrompt = await deps.inspect({ runtime: opts.runtime });
    if (!sameOwner(confirmed, afterPrompt)) {
      throw uncertain();
    }
    await verifyRoute({
      runtime: opts.runtime,
      owner: afterPrompt,
      hostname: opts.hostname,
      dependencies: deps,
    });
    const installed = await deps.runCommand(
      [
        "sudo",
        "-n",
        "/usr/bin/security",
        "add-trusted-cert",
        "-d",
        "-r",
        "trustRoot",
        "-k",
        "/Library/Keychains/System.keychain",
        staged,
      ],
      { stdin: "ignore", timeoutMs: 15_000 }
    );
    if (installed !== 0) {
      throw new Error("macOS did not install the verified native Caddy root.");
    }
    const final = await deps.inspect({ runtime: opts.runtime });
    if (!sameOwner(afterPrompt, final)) {
      throw uncertain();
    }
    if (opts.hostname) {
      await verifyRoute({
        runtime: opts.runtime,
        owner: final,
        hostname: opts.hostname,
        dependencies: deps,
      });
    }
    const trust = await deps.trust({ certPath: staged });
    if (!trust.trusted) {
      throw new Error(
        trust.issue ?? "macOS did not verify the live native Caddy root."
      );
    }
    const afterTrust = await deps.inspect({ runtime: opts.runtime });
    if (!sameOwner(final, afterTrust)) {
      throw uncertain();
    }
    return "installed";
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
