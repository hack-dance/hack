import { CLOUDFLARE_EXTENSION } from "./cloudflare/extension.ts";
import { GATEWAY_EXTENSION } from "./gateway/extension.ts";
import { GITHUB_EXTENSION } from "./github/extension.ts";
import { LINEAR_EXTENSION } from "./linear/extension.ts";
import { SUPERVISOR_EXTENSION } from "./supervisor/extension.ts";
import { TAILSCALE_EXTENSION } from "./tailscale/extension.ts";
import { TICKETS_EXTENSION } from "./tickets/extension.ts";

export const BUILTIN_EXTENSIONS = [
  TICKETS_EXTENSION,
  SUPERVISOR_EXTENSION,
  GATEWAY_EXTENSION,
  GITHUB_EXTENSION,
  LINEAR_EXTENSION,
  CLOUDFLARE_EXTENSION,
  TAILSCALE_EXTENSION,
] as const;
