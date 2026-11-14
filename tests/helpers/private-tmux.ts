import { mkdtempSync, rmSync } from "node:fs";
import { restoreEnv } from "./env.ts";
import { registerPrivateTmuxRoot } from "./tmux-socket-guard.ts";

/** Own one short socket root, and always stop its server before removing it. */
export function privateTmux(opts: { restoreEnvironment?: boolean } = {}): {
  close(): void;
} {
  const root = mkdtempSync("/tmp/hack-test-mux-");
  const unregister = registerPrivateTmuxRoot(root);
  const savedRoot = process.env.TMUX_TMPDIR;
  const savedTmux = process.env.TMUX;
  const tmux = Bun.which("tmux");
  let closed = false;
  process.env.TMUX_TMPDIR = root;
  Reflect.deleteProperty(process.env, "TMUX");
  return {
    close() {
      if (closed) {
        return;
      }
      let stopped = tmux === null;
      try {
        if (tmux) {
          // Explicit environment cannot be redirected by a failing test.
          const result = Bun.spawnSync([tmux, "kill-server"], {
            env: { PATH: process.env.PATH ?? "", TMUX_TMPDIR: root },
            stdout: "ignore",
            stderr: "ignore",
            timeout: 5000,
          });
          // 1 means there was no server. A timeout/signal is not cleanup:
          // retain the root so a live server's socket is not unlinked.
          stopped = [0, 1].includes(result.exitCode) && !result.signalCode;
          if (!stopped) {
            throw new Error(
              "Private test tmux server did not stop; retained its socket root."
            );
          }
        }
      } finally {
        if (opts.restoreEnvironment !== false) {
          restoreEnv("TMUX_TMPDIR", savedRoot);
          restoreEnv("TMUX", savedTmux);
        }
        if (stopped) {
          unregister();
          rmSync(root, { recursive: true, force: true });
          closed = true;
        }
      }
    },
  };
}
