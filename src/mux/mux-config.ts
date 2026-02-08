import { readGlobalConfig } from "../lib/config.ts";
import type { ProjectContext } from "../lib/project.ts";
import { readProjectConfig } from "../lib/project.ts";

export type SessionsMuxMode = "auto" | "tmux" | "zellij" | "none";

export function parseSessionsMuxMode(value: unknown): SessionsMuxMode | null {
  if (typeof value !== "string") {
    return null;
  }
  const v = value.trim().toLowerCase();
  if (v === "auto") {
    return "auto";
  }
  if (v === "tmux") {
    return "tmux";
  }
  if (v === "zellij") {
    return "zellij";
  }
  if (v === "none") {
    return "none";
  }
  return null;
}

export async function resolveSessionsMuxMode(opts: {
  readonly project?: ProjectContext | null;
}): Promise<SessionsMuxMode> {
  const envRaw = (process.env.HACK_SESSIONS_MUX ?? "").trim();
  const envMode = parseSessionsMuxMode(envRaw);
  if (envMode) {
    return envMode;
  }

  if (opts.project) {
    const cfg = await readProjectConfig(opts.project);
    const projectMode = parseSessionsMuxMode(cfg.sessions?.mux);
    if (projectMode) {
      return projectMode;
    }
  }

  const globalModeRaw = await readGlobalConfig({ path: "sessions.mux" });
  const globalMode = parseSessionsMuxMode(globalModeRaw);
  if (globalMode) {
    return globalMode;
  }

  return "auto";
}
