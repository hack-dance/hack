// Rollup ships a native binary per platform, so it only loads when it was
// installed for the platform the container runs on.
import { VERSION } from "rollup";

Bun.serve({
  port: 3000,
  fetch: () => Response.json({ rollup: VERSION, platform: process.platform, arch: process.arch }),
});
