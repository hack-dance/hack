import type { ProjectContext } from "../lib/project.ts";

import type { MuxBackend, MuxBackendName } from "./mux-backend.ts";
import { resolveSessionsMuxMode, type SessionsMuxMode } from "./mux-config.ts";
import { createTmuxBackend } from "./tmux-backend.ts";
import { createZellijBackend } from "./zellij-backend.ts";

export type ResolvedMux = {
  readonly mode: SessionsMuxMode;
  readonly backends: ReadonlyMap<MuxBackendName, MuxBackend>;
};

export function getMuxBackends(): ReadonlyMap<MuxBackendName, MuxBackend> {
  const tmux = createTmuxBackend();
  const zellij = createZellijBackend();
  return new Map([
    ["tmux", tmux],
    ["zellij", zellij],
  ]);
}

export async function resolveMux(opts: {
  readonly project?: ProjectContext | null;
}): Promise<ResolvedMux> {
  const mode = await resolveSessionsMuxMode({ project: opts.project });
  return { mode, backends: getMuxBackends() };
}

export function resolveMuxCandidates(opts: {
  readonly mode: SessionsMuxMode;
}): readonly MuxBackendName[] {
  if (opts.mode === "none") {
    return [];
  }
  if (opts.mode === "tmux") {
    return ["tmux"];
  }
  if (opts.mode === "zellij") {
    return ["zellij"];
  }
  return ["tmux", "zellij"];
}

export function resolveDefaultBackendName(opts: {
  readonly mode: SessionsMuxMode;
  readonly backends: ReadonlyMap<MuxBackendName, MuxBackend>;
}): MuxBackendName | null {
  for (const name of resolveMuxCandidates({ mode: opts.mode })) {
    const backend = opts.backends.get(name);
    if (backend?.available) {
      return name;
    }
  }
  return null;
}

export async function listMuxSessions(opts: {
  readonly mode: SessionsMuxMode;
  readonly backends: ReadonlyMap<MuxBackendName, MuxBackend>;
}): Promise<
  readonly Awaited<ReturnType<MuxBackend["listSessions"]>>[number][]
> {
  const out: Awaited<ReturnType<MuxBackend["listSessions"]>>[number][] = [];
  for (const name of resolveMuxCandidates({ mode: opts.mode })) {
    const backend = opts.backends.get(name);
    if (!backend?.available) {
      continue;
    }
    const sessions = await backend.listSessions();
    out.push(...sessions);
  }
  return out;
}
