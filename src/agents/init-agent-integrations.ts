import { note } from "@clack/prompts";

/** Init only points at optional tools. It never exports instructions, skills, hooks or client config. */
export function renderInitAgentIntegrationNote(): string {
  return [
    "No coding-agent files were written to this repository.",
    "Use the optional Hack plugin and invoke its skills when you need them.",
    "Codex: codex plugin add hack@hack-dance",
    "MCP is a separate explicit opt-in; select its client, scope and verified executable yourself.",
    "Print setup guidance when requested: hack agent onboard",
    "Existing instructions, skills and client settings are left unchanged.",
  ].join("\n");
}
export type InitAgentIntegrationPrompts = {
  readonly note: (opts: {
    readonly message: string;
    readonly title: string;
  }) => void;
};
export type InitAgentIntegrationOutcome = {
  readonly kind: "skipped" | "note-only";
};
export async function runInitAgentIntegrations(opts: {
  readonly repoRoot: string;
  readonly interactive: boolean;
  readonly guard: (opts: { readonly projectRoot: string }) => Promise<void>;
  readonly prompts?: InitAgentIntegrationPrompts;
}): Promise<InitAgentIntegrationOutcome> {
  await opts.guard({ projectRoot: opts.repoRoot });
  if (!opts.interactive) {
    return { kind: "skipped" };
  }
  (opts.prompts?.note ?? ((value) => note(value.message, value.title)))({
    message: renderInitAgentIntegrationNote(),
    title: "Optional coding-agent tools",
  });
  return { kind: "note-only" };
}
