/**
 * The label every container a data command creates carries, with the run's
 * random nonce. It is how a container whose create outcome Hack could not
 * reconcile is found again; the value is random, never a managed value.
 */
export const HELPER_NONCE_LABEL = "io.hack.data-backup.nonce";

/** A nonce as Hack generates it: 32 lowercase hex characters. */
export const HELPER_NONCE_PATTERN = /^[0-9a-f]{32}$/;

/**
 * The only recovery instruction for a container whose create Hack could not
 * reconcile: `hack data cleanup --nonce <nonce>`, which reads the run's
 * cleanup record (the engine selection it used) and refuses unless it
 * resolves to the same engine. No raw `docker` command is printed: it would
 * need the engine endpoint, and no endpoint value (a DOCKER_HOST or a
 * context's endpoint) may appear in any output. `hackCommand` is the CLI's
 * own line with the run's project and instance selection, when known.
 */
export function cleanupInstruction(opts: {
  readonly nonce: string;
  readonly hackCommand?: string;
}): string {
  return opts.hackCommand ?? `hack data cleanup --nonce=${opts.nonce}`;
}
