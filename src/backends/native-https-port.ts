import { createServer } from "node:net";

/** Check local bind permission without adopting or stopping an existing listener.
 * Caddy must still acquire the port itself; this check cannot reserve it.
 */
export async function checkNativeHttpsPort(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      let reason = "could not be checked";
      if (error.code === "EACCES" || error.code === "EPERM") {
        reason =
          "requires host permission; use an unprivileged port for testing or configure authorized host forwarding";
      } else if (error.code === "EADDRINUSE") {
        reason = "is already in use; the existing listener was left untouched";
      }
      reject(new Error(`Native HTTPS port ${port} ${reason}.`));
    });
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => {
        if (error) {
          reject(new Error("Native HTTPS port probe could not close."));
        } else {
          resolve();
        }
      });
    });
  });
}
