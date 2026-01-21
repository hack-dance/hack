import { CLOUDFLARE_EXTENSION } from "./cloudflare/extension.ts";
import { GATEWAY_EXTENSION } from "./gateway/extension.ts";
import { SUPERVISOR_EXTENSION } from "./supervisor/extension.ts";
import { TAILSCALE_EXTENSION } from "./tailscale/extension.ts";
import { TICKETS_EXTENSION } from "./tickets/extension.ts";

export const BUILTIN_EXTENSIONS = [
  TICKETS_EXTENSION,
  SUPERVISOR_EXTENSION,
  GATEWAY_EXTENSION,
  CLOUDFLARE_EXTENSION,
  TAILSCALE_EXTENSION,
] as const;
