import { open, realpath } from "node:fs/promises";
import { basename } from "node:path";

/** Optional fixture acceleration must never install a runtime or execute a
 * version-manager shim. Its descendants/pipes have no fixture owner. Callers
 * can put a direct installed Node on PATH; all other cases retain Bun.
 */
export async function optionalFixtureNode(
  path = process.env.PATH ?? ""
): Promise<string | null> {
  const selected = Bun.which("node", { PATH: path });
  if (!selected) {
    return null;
  }
  try {
    const executable = await realpath(selected);
    if (basename(executable) !== "node") {
      return null;
    }
    const handle = await open(executable, "r");
    const header = Buffer.alloc(4);
    try {
      await handle.read(header, 0, 4, 0);
    } finally {
      await handle.close();
    }
    // ELF and Mach-O (including universal) executables. A script called node
    // remains a shim even if its path happens to end with that name.
    if (
      !new Set([
        "7f454c46",
        "cffaedfe",
        "feedfacf",
        "cefaedfe",
        "feedface",
        "cafebabe",
        "bebafeca",
        "cafebabf",
        "bfbafeca",
      ]).has(header.toString("hex"))
    ) {
      return null;
    }
    const child = Bun.spawn(
      [
        executable,
        "--input-type=module",
        "-e",
        'import * as fs from "node:fs/promises"; if(Number(process.versions.node.split(".")[0]) < 18) process.exit(1); await fs.stat(process.execPath);',
      ],
      {
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        timeout: 5000,
        killSignal: "SIGKILL",
      }
    );
    return (await child.exited) === 0 ? executable : null;
  } catch {
    return null;
  }
}
