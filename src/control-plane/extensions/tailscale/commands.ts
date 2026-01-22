import { display } from "../../../ui/display.ts";

import type { ExtensionCommand } from "../types.ts";

export const TAILSCALE_COMMANDS: readonly ExtensionCommand[] = [
  {
    name: "setup",
    summary: "Print Tailscale setup guidance",
    scope: "global",
    handler: async ({ ctx }) => {
      const check = await ensureTailscale();
      if (!check.ok) {
        ctx.logger.error({ message: check.error });
        return 1;
      }

      const lines = [
        "1) Join tailnet: tailscale up",
        "2) Optional SSH: tailscale up --ssh",
        "3) Confirm status: tailscale status",
        "4) Get IP: tailscale ip -4",
        "5) Use SSH: ssh <user>@<tailscale-ip>",
      ];

      await display.panel({
        title: "Tailscale setup",
        tone: "info",
        lines,
      });
      return 0;
    },
  },
  {
    name: "status",
    summary: "Run tailscale status",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const check = await ensureTailscale();
      if (!check.ok) {
        ctx.logger.error({ message: check.error });
        return 1;
      }
      return await runTailscale({ args: ["status", ...args], inherit: true });
    },
  },
  {
    name: "ip",
    summary: "Show tailscale IP addresses",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const check = await ensureTailscale();
      if (!check.ok) {
        ctx.logger.error({ message: check.error });
        return 1;
      }
      const cmdArgs = args.length > 0 ? ["ip", ...args] : ["ip", "-4"];
      return await runTailscale({ args: cmdArgs, inherit: true });
    },
  },
];

async function ensureTailscale(): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  const exitCode = await runTailscale({ args: ["--version"], inherit: false });
  if (exitCode !== 0) {
    return {
      ok: false,
      error: "tailscale not found. Install with: brew install tailscale",
    };
  }
  return { ok: true };
}

async function runTailscale(opts: {
  readonly args: readonly string[];
  readonly inherit: boolean;
}): Promise<number> {
  const proc = Bun.spawn(["tailscale", ...opts.args], {
    stdin: opts.inherit ? "inherit" : "ignore",
    stdout: opts.inherit ? "inherit" : "pipe",
    stderr: "inherit",
  });

  if (!opts.inherit) {
    await new Response(proc.stdout).text();
  }

  return await proc.exited;
}
