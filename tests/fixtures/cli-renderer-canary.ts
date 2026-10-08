import { join } from "node:path";
import type { BunPlugin } from "bun";

/**
 * Runtime plugins bypass bare package specifiers. Rewrite only the two original
 * source imports to a real module whose body proves evaluation before rendering.
 */
export const rendererCanary: BunPlugin = {
  name: "isolated-cli-renderer-loading-canary",
  setup(build) {
    build.onLoad(
      { filter: /[/\\]src[/\\](?:commands[/\\]remote|tui[/\\]hack-tui)\.ts$/ },
      async ({ path }) => {
        const contents = await Bun.file(path).text();
        const specifier = '"@opentui/core"';
        if (!contents.includes(specifier)) {
          throw new Error("Missing renderer import in loading control.");
        }
        return {
          loader: "ts",
          contents: contents.replaceAll(
            specifier,
            JSON.stringify(join(import.meta.dir, "cli-renderer-module.ts"))
          ),
        };
      }
    );
  },
};
