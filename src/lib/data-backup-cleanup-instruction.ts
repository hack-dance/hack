import type { DataBackupEngineSelection } from "./data-backup-docker.ts";

/**
 * The label every container a data command creates carries, with a random
 * per-create value. It is how a container whose create outcome Hack could
 * not reconcile is found again; the value is random, never a managed value.
 */
export const HELPER_NONCE_LABEL = "io.hack.data-backup.nonce";

/** A nonce as Hack generates it: 32 lowercase hex characters. */
export const HELPER_NONCE_PATTERN = /^[0-9a-f]{32}$/;

/** A DOCKER_HOST holding any of these may carry a credential or shell meta. */
const UNPRINTABLE_HOST = /[@?#\s'"`$\\]/;
/** A context name that is safe to print unquoted. */
const PRINTABLE_CONTEXT = /^[A-Za-z0-9._@:/[\]-]+$/;

/** Shortest managed value redacted from a printed engine selection. */
const REDACT_MIN_VALUE_CHARS = 4;

/**
 * The raw `docker` command that finds and removes the containers labeled
 * with `nonce`, on the same engine the data command used. A managed
 * `DOCKER_HOST` is printed only when it holds no userinfo, no query and no
 * other managed value (which could be a secret); otherwise the instruction
 * says to run the command against the managed `DOCKER_HOST` without
 * printing it. A managed `DOCKER_CONTEXT` name is printed with any other
 * managed value in it redacted. Without a managed selection the command
 * targets the caller's own engine.
 */
export function rawCleanupInstruction(opts: {
  readonly nonce: string;
  readonly engine: DataBackupEngineSelection | undefined;
  readonly redactValues: readonly string[];
}): { readonly command: string; readonly sentence: string } {
  const filter = `--filter label=${HELPER_NONCE_LABEL}=${opts.nonce}`;
  const host = opts.engine?.host ?? null;
  const context = opts.engine?.context ?? null;
  if (host !== null) {
    if (printableHost({ host, redactValues: opts.redactValues })) {
      const command = `DOCKER_HOST=${host} docker ps -aq ${filter} | DOCKER_HOST=${host} xargs -r docker rm -f`;
      return { command, sentence: `\`${command}\`` };
    }
    const command = `docker ps -aq ${filter} | xargs -r docker rm -f`;
    return {
      command,
      sentence: `\`${command}\`, run with your managed DOCKER_HOST (not printed)`,
    };
  }
  if (context !== null) {
    const name = redactOthers({
      value: context,
      redactValues: opts.redactValues,
    });
    const command = `docker --context ${name} ps -aq ${filter} | xargs -r docker --context ${name} rm -f`;
    return { command, sentence: `\`${command}\`` };
  }
  const command = `docker ps -aq ${filter} | xargs -r docker rm -f`;
  return { command, sentence: `\`${command}\`` };
}

/** Whether a managed DOCKER_HOST value may be printed. */
function printableHost(opts: {
  readonly host: string;
  readonly redactValues: readonly string[];
}): boolean {
  if (UNPRINTABLE_HOST.test(opts.host)) {
    return false;
  }
  return !opts.redactValues.some(
    (value) =>
      value !== opts.host &&
      value.length >= REDACT_MIN_VALUE_CHARS &&
      opts.host.includes(value)
  );
}

/** `value` with every other managed value in it redacted. */
function redactOthers(opts: {
  readonly value: string;
  readonly redactValues: readonly string[];
}): string {
  let out = opts.value;
  for (const secret of [...opts.redactValues]
    .filter(
      (value) => value !== opts.value && value.length >= REDACT_MIN_VALUE_CHARS
    )
    .sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join("[REDACTED]");
  }
  return PRINTABLE_CONTEXT.test(out) ? out : "'<context>'";
}
