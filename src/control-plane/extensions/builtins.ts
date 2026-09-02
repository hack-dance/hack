import { CLOUDFLARE_EXTENSION } from "./cloudflare/extension.ts";
import { GATEWAY_EXTENSION } from "./gateway/extension.ts";
import { SUPERVISOR_EXTENSION } from "./supervisor/extension.ts";
import { TAILSCALE_EXTENSION } from "./tailscale/extension.ts";

export const BUILTIN_EXTENSIONS = [
  SUPERVISOR_EXTENSION,
  GATEWAY_EXTENSION,
  CLOUDFLARE_EXTENSION,
  TAILSCALE_EXTENSION,
] as const;
