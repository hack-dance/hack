import { promptAttachedWorkspaceAction } from "../../src/commands/session.ts";
import { HackCliError } from "../../src/lib/cli-result.ts";

/**
 * Worker for tests/no-tty-prompt-sites-cli.test.ts. It calls the session
 * "workspace is attached elsewhere" prompt in its own process, so a regressed
 * guard spins here and is killed by the test's timeout instead of hanging the
 * test runner. Prints `action:<value>` on success, or one `<code>: <message>`
 * line for a HackCliError, and exits 1 on any error.
 */
try {
  const action = await promptAttachedWorkspaceAction({
    attachedWorkspaceName: "demo",
    nextWorkspaceName: "demo-2",
  });
  process.stdout.write(`action:${String(action)}\n`);
  process.exit(0);
} catch (error: unknown) {
  process.stderr.write(
    error instanceof HackCliError
      ? `${error.code}: ${error.message}\n`
      : "E_WORKER_FAILED: unexpected error\n"
  );
  process.exit(1);
}
