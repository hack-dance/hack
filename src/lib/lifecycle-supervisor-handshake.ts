/** Exact `--version` reply this CLI requires from its sibling supervisor. */
export const LIFECYCLE_SUPERVISOR_VERSION =
  "hack-lifecycle-supervisor 0.1.0 protocol=1 incremental=1";

/**
 * Hidden CLI argument printing LIFECYCLE_SUPERVISOR_VERSION, so an installer
 * can check a staged companion against its staged CLI. CLIs released before
 * the companion do not answer it.
 */
export const LIFECYCLE_SUPERVISOR_HANDSHAKE_ARGUMENT =
  "--internal-lifecycle-supervisor-handshake";
