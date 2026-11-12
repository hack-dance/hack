import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NativeProjectRunScope } from "../../src/backends/native-project-run.ts";
import frontend from "../fixtures/native-next13/frontend.json";
import mapping from "../fixtures/native-next13/mapping.json";

/** Materialize old-writer bytes, replacing only fixture filesystem/process identities. */
export async function installNext13Frontend(opts: {
  readonly scope: NativeProjectRunScope;
  /** A child started and reaped by this fixture, never an arbitrary host PID. */
  readonly exitedPid: number;
}): Promise<void> {
  const identity = async (path: string) => {
    const value = await stat(path);
    return { dev: value.dev, ino: value.ino };
  };
  const selected = {
    ...opts.scope,
    rootIdentity: await identity(opts.scope.projectRoot),
    dirIdentity: await identity(opts.scope.projectDir),
    homeIdentity: await identity(opts.scope.nativeHome),
  };
  const runs = join(opts.scope.projectDir, ".internal/native-runs");
  await mkdir(runs, { recursive: true, mode: 0o700 });
  await writeFile(join(runs, ".gitignore"), "*\n", { mode: 0o600 });
  const key = createHash("sha256")
    .update(JSON.stringify(opts.scope.branch))
    .digest("hex");
  await writeFile(
    join(runs, `${key}.json`),
    JSON.stringify({ ...mapping, scope: selected }),
    { mode: 0o600 }
  );
  const scopeHash = createHash("sha256")
    .update(
      JSON.stringify({
        home: opts.scope.nativeHome,
        projectRoot: opts.scope.projectRoot,
        projectDir: opts.scope.projectDir,
        branch: opts.scope.branch,
      })
    )
    .digest("hex");
  const root = join(
    opts.scope.nativeHome,
    ".hack-local/frontend-finalization",
    scopeHash,
    mapping.run.run
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, "active.json"),
    JSON.stringify({ ...frontend, scope: scopeHash, pid: opts.exitedPid }),
    { mode: 0o600 }
  );
}
