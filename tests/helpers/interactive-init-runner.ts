import { CLI_SPEC } from "../../src/cli/spec.ts";
import {
  handleInit,
  type InitInteractiveIo,
} from "../../src/commands/project.ts";

/**
 * Child-process entry for the interactive `hack init` path with scripted
 * terminal seams. The TTY check passes and every prompt takes its default:
 * a fresh repo gets `.hack/` scaffolded (with a fixed, service-free compose
 * in place of the service wizard), and an existing `.hack/` is kept because
 * the overwrite confirm defaults to "no". No agent files are exported. Spawn it with `privateCliEnv` and a PATH without agent CLIs, so
 * the interactive handoff prints its copy-paste fallback instead of launching.
 *
 * Usage: bun tests/helpers/interactive-init-runner.ts <repo> <claude|codex|none> [overwrite]
 *
 * `none` runs without `--with`. `overwrite` answers "yes" to the
 * "Overwrite scaffold files?" confirm for an existing `.hack/`.
 */

const [repo, withArg, overwriteArg] = process.argv.slice(2);
if (
  !(repo && withArg) ||
  (overwriteArg !== undefined && overwriteArg !== "overwrite")
) {
  throw new Error(
    "usage: interactive-init-runner.ts <repo> <claude|codex|none> [overwrite]"
  );
}
const withValue = withArg === "none" ? undefined : withArg;
const overwrite = overwriteArg === "overwrite";

const io: InitInteractiveIo = {
  canPrompt: () => true,
  text: async ({ initialValue }) => initialValue,
  confirm: async ({ message, initialValue }) =>
    overwrite && message.endsWith("Overwrite scaffold files?")
      ? true
      : initialValue,
  // The service wizard is out of scope here; a fixed compose keeps it inert.
  composeWizard: async ({ input }) =>
    `name: ${input.projectSlug}\nservices: {}\n`,
  agentPrompts: {
    note: () => undefined,
    confirm: async ({ initialValue }) => initialValue,
    multiselect: async () => [],
  },
};

type InitInput = Parameters<typeof handleInit>[0];

const args = {
  options: {
    path: repo,
    manual: false,
    auto: false,
    name: undefined,
    devHost: undefined,
    oauth: false,
    oauthTld: undefined,
    noDiscovery: false,
    with: withValue,
  },
  positionals: {},
  raw: {
    argv: [
      "init",
      "--path",
      repo,
      ...(withValue === undefined ? [] : ["--with", withValue]),
    ],
    positionals: [],
  },
} as unknown as InitInput["args"];

process.exitCode = await handleInit({
  ctx: { cwd: repo, cli: CLI_SPEC },
  args,
  io,
});
