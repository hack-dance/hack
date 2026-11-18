import { resolve } from "node:path";

import { pathExists } from "./fs.ts";

export interface HackInvocation {
  readonly bin: string;
  readonly args: readonly string[];
}

export async function resolveHackInvocation(opts?: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  /** Injected for tests; default `Bun.main` and `process.execPath`. */
  readonly main?: string;
  readonly execPath?: string;
}): Promise<HackInvocation> {
  const env = opts?.env ?? process.env;
  const main = opts?.main ?? Bun.main;
  const override = (env.HACK_MCP_COMMAND ?? "").trim();
  if (override.length > 0) {
    return { bin: override, args: [] };
  }

  const fromPath = Bun.which("hack", { PATH: env.PATH ?? "", cwd: opts?.cwd });
  if (fromPath) {
    return { bin: fromPath, args: [] };
  }

  // A compiled CLI's script path is virtual (`/$bunfs/...`), so the argv form
  // below cannot name it; run the executable itself. Without this, a compiled
  // `hack` started by its path with no `hack` on PATH resolved to a bare
  // `hack` that does not exist, and `hack daemon start` failed unseen
  // (HACK-2329).
  // On Linux `process.execPath` is the resolved real path, so a unit or MCP
  // config written in this case names that exact (possibly versioned) file.
  if (main.startsWith("/$bunfs/") || main.includes("~BUN")) {
    return { bin: opts?.execPath ?? process.execPath, args: [] };
  }

  const argv0 = process.argv[0];
  const argv1 = process.argv[1];
  if (argv0 && argv1) {
    const candidate = await resolveArgvPath({ raw: argv1 });
    if (candidate) {
      return { bin: argv0, args: [candidate] };
    }
  }

  return { bin: "hack", args: [] };
}

async function resolveArgvPath({
  raw,
}: {
  readonly raw: string;
}): Promise<string | null> {
  if (await pathExists(raw)) {
    return raw;
  }
  const resolved = resolve(process.cwd(), raw);
  return (await pathExists(resolved)) ? resolved : null;
}
