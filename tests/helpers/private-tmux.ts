import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { restoreEnv } from "./env.ts";
import { registerPrivateTmuxRoot } from "./tmux-socket-guard.ts";

/** Every Unix socket under a private root; symlinks are never followed. */
export function privateSockets(root: string): string[] {
  const sockets: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      sockets.push(...privateSockets(path));
    } else if (lstatSync(path).isSocket()) {
      sockets.push(path);
    }
  }
  return sockets;
}

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
          // The guard accepts `-L name` and `-S <root>/x.sock`, so a test can
          // start servers besides the root's default one. Stop every socket
          // under the root, not just the default server.
          stopped = privateSockets(root).every((socket) => {
            // tmux keeps `-L`/default sockets in `<root>/tmux-<uid>/`; that
            // directory is inside this owned root, so admit it for the kill.
            const unregisterDir = registerPrivateTmuxRoot(dirname(socket));
            // Explicit environment cannot be redirected by a failing test.
            const result = Bun.spawnSync([tmux, "-S", socket, "kill-server"], {
              env: { PATH: process.env.PATH ?? "", TMUX_TMPDIR: root },
              stdout: "ignore",
              stderr: "ignore",
              timeout: 5000,
            });
            if (dirname(socket) !== root) {
              unregisterDir();
            }
            // 1 means no server answered (a stale socket). A timeout/signal is
            // not cleanup: retain the root so a live server's socket is kept.
            return [0, 1].includes(result.exitCode) && !result.signalCode;
          });
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
