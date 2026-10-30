/** v5 no longer owns instruction injection, automatic skill refresh or broad client sync. */
export const RETIRED_AGENT_AUTOMATION_MESSAGE =
  "Automatic agent instructions, hooks and integration sync are retired in v5. No files were changed. Use an explicitly selected Hack plugin, opt-in skill or MCP installation; review existing files manually before any cleanup.";

/** Old installed hooks may still call this command; never inject full guidance through them. */
export const RETIRED_AGENT_PRIMER_MESSAGE =
  "Hack's automatic agent primer is retired in v5. Use explicitly invoked Hack plugin skills or opt-in MCP. Existing hook settings were left unchanged.";
