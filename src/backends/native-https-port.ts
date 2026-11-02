import { createServer } from "node:net";
import { ClosedCliError, HackCliError } from "../lib/cli-result.ts";

/** Closed, value-free refusal for a selected HTTPS port that cannot be bound. */
function portRefusal(code: string | undefined): Error {
  if (code === "EACCES" || code === "EPERM") {
    return new HackCliError({
      code: "E_PERMISSION",
      message:
        "The selected native HTTPS port requires host permission; use an unprivileged port for testing or configure authorized host forwarding.",
    });
  }
  if (code === "EADDRINUSE") {
    return new HackCliError({
      code: "E_CONFIG_INVALID",
      message:
        "The selected native HTTPS port is already in use; the existing listener was left untouched. Select a free port.",
    });
  }
  return new ClosedCliError(
    "The selected native HTTPS port could not be checked; values omitted."
  );
}

/** Check local bind permission without adopting or stopping an existing listener.
 * Caddy must still acquire the port itself; this check cannot reserve it.
 */
export async function checkNativeHttpsPort(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(portRefusal(error.code));
    });
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => {
        if (error) {
          reject(
            new ClosedCliError("Native HTTPS port probe could not close.")
          );
        } else {
          resolve();
        }
      });
    });
  });
}
