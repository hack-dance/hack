import { privateTmux } from "./private-tmux.ts";
import { installTmuxSocketGuard } from "./tmux-socket-guard.ts";

// Before the global-state baseline. This covers in-process mux calls and
// children using privateCliEnv, including daemon route validation tests.
installTmuxSocketGuard();
export const testMux = privateTmux({ restoreEnvironment: false });
