import { INSTRUCTION_SECTIONS } from "./instruction-source.ts";

/**
 * Single source of truth for the agent-assisted onboarding prompt.
 *
 * Consumers (keep this list current — the content must never fork):
 * - `hack init --with claude|codex|both` (CLI handoff for new repos),
 * - `hack agent onboard` (CLI print for existing projects),
 * - the `/hack-init` agent-side skill (thin pointer installed by
 *   `hack setup claude|codex`),
 * - the `hack-init` MCP prompt (no-shell clients),
 * - the copy-paste bootstrap block in `docs/guides/agent-first-setup.md`.
 */

export type OnboardingMode = "new-project" | "existing-project";

const RUNNING_THINGS_SECTION_ID = "running-things";

const DEPS_CONTAINER_SNIPPET = [
  "  services:",
  "    deps:",
  "      image: oven/bun:1 # match the project runtime (node:22, etc)",
  "      working_dir: /app",
  "      volumes:",
  "        - ..:/app",
  "        - node_modules:/app/node_modules",
  '      command: ["bun", "install"]',
  "    api:",
  "      working_dir: /app",
  "      volumes:",
  "        - ..:/app",
  "        - node_modules:/app/node_modules",
  "      depends_on:",
  "        deps:",
  "          condition: service_completed_successfully",
  "  volumes:",
  "    node_modules:",
].join("\n");

/**
 * Render the canonical project-onboarding prompt for a coding agent.
 *
 * The prompt walks an agent through inventorying a repo, standing hack up
 * (or adopting an existing `.hack/` setup), platform nuances (deps/ops
 * containers), the running-things decision guide, and a verification loop.
 *
 * @param opts.mode - `new-project` when `.hack/` does not exist yet;
 *   `existing-project` when hack is already configured and should be
 *   adopted/refined.
 * @param opts.projectName - Known project slug (from config), when available.
 * @param opts.devHost - Known dev host (from config), when available.
 */
export function renderOnboardingPrompt(opts: {
  readonly mode: OnboardingMode;
  readonly projectName?: string;
  readonly devHost?: string;
}): string {
  const lines: string[] = [];

  lines.push(renderHeader(opts));
  lines.push("");
  lines.push(...renderIntro(opts));
  lines.push("");
  lines.push(...renderInventoryPhase());
  lines.push("");
  lines.push(...renderSetupPhase(opts));
  lines.push("");
  lines.push(...renderPlatformPhase());
  lines.push("");
  lines.push(...renderRunningThingsPhase());
  lines.push("");
  lines.push(...renderVerifyPhase(opts));
  lines.push("");
  lines.push(...renderGroundRules());
  lines.push("");

  return lines.join("\n");
}

function renderHeader(opts: {
  readonly mode: OnboardingMode;
  readonly projectName?: string;
}): string {
  const label =
    opts.mode === "new-project"
      ? "stand up hack in this repo"
      : "adopt the existing hack setup in this repo";
  const suffix = opts.projectName ? ` (project: ${opts.projectName})` : "";
  return `# hack onboarding — ${label}${suffix}`;
}

function renderIntro(opts: { readonly mode: OnboardingMode }): string[] {
  const goal =
    opts.mode === "new-project"
      ? "Your goal: every service in this repo runs under hack (docker compose + Caddy DNS/TLS + managed env), verified end to end."
      : "Your goal: understand and complete this project's hack setup so every service runs under hack, verified end to end.";
  return [
    "You are a coding agent setting this repository up to run with the hack CLI (local-first runtime orchestration: compose, DNS/TLS, logs, env).",
    goal,
    "Work through the phases in order. Prefer `hack` commands over raw `docker` / `docker compose`. Run `hack help <cmd>` when unsure about flags.",
  ];
}

function renderInventoryPhase(): string[] {
  return [
    "## Phase 1 — Inventory the repo",
    "",
    "- Read the root package.json, workspace globs, and lockfiles to identify the package manager and monorepo layout.",
    "- Identify runnable services (web, api, workers): dev/start scripts, framework configs, and the ports they listen on.",
    "- Detect databases, caches, and queues from code and config: ORM schemas (prisma/drizzle), migration dirs, existing Dockerfiles and compose files.",
    "- List every `.env*` file. Their keys and values are candidates for `hack env add`; treat `.env.example` values as placeholders (ask the user for real values or leave them unset). Not every repo has `.env*` files — also harvest candidate keys from `environment:` blocks in existing compose files, `ENV` lines in Dockerfiles, and CI config (workflow env/secrets).",
    "- Note repo scripts that need env vars to run (migrations, seeds, codegen) — they will run via `hack host exec` or an ops container later.",
    "- Read README/docs for one-time setup steps you might otherwise miss.",
  ];
}

function renderSetupPhase(opts: {
  readonly mode: OnboardingMode;
  readonly devHost?: string;
}): string[] {
  const devHostExample = opts.devHost ?? "<project>.hack";
  const bootstrap =
    opts.mode === "new-project"
      ? "- Scaffold config: run `hack init --auto` (add `--name <slug>` / `--dev-host <host>` when the defaults are wrong). If `.hack/` already exists, edit the config instead of re-running init."
      : "- `.hack/` already exists: review `.hack/hack.config.json` and `.hack/docker-compose.yml` and refine them; do not re-run `hack init` unless the user asks for a reset.";

  return [
    "## Phase 2 — Set up hack",
    "",
    bootstrap,
    "- Decide full containerization vs backing-services-only (partial adoption): if the inventory shows heavy native toolchains (.NET, large native builds) or the human prefers host dev servers, compose backing services (db/queue/cache) only and keep app dev servers on the host pointed at the routed services — ask the human when it's ambiguous; partial adoption is a valid end state, not a fallback to fix later.",
    "- Check for reuse before authoring new services: if the repo already containerizes for prod (existing Dockerfiles/compose with build contexts, runtime-config injection points like an nginx-served runtime-config.js), prefer reusing those images/contexts with minimal glue over hand-authoring new dev-mode services from scratch.",
    "- Define one compose service per runnable process in `.hack/docker-compose.yml`. HTTP services need the Caddy labels (`caddy`, `caddy.reverse_proxy`, `caddy.tls=internal`) and the `hack-dev` network to be routable.",
    `- Design hostnames: the primary app answers on dev_host (${devHostExample}); every other routable service gets a subdomain (\`api.${devHostExample}\`, \`grafana.${devHostExample}\`, ...). Set dev_host in \`.hack/hack.config.json\`.`,
    "- Migrate env values: for each key found during inventory run `hack env add <KEY> <value>` — add `--secret` for anything sensitive (API keys, tokens, passwords, connection strings with credentials). Never commit plaintext secrets to the repo.",
    "- After migration the `.env` files are superseded: containers get env injected by hack, and host scripts run through `hack host exec --env <overlay> --scope <service> -- <cmd...>` instead of reading `.env` files.",
    "- Encode required host-side setup (tunnels, proxies, credential bootstrap) in `.hack/hack.config.json` under `startup`/`lifecycle` — not in ad-hoc terminal instructions.",
  ];
}

function renderPlatformPhase(): string[] {
  return [
    "## Phase 3 — Platform nuances (macOS host, linux containers)",
    "",
    "- Deps container pattern: native/node dependencies MUST be installed inside linux containers. Use a named `node_modules` volume plus a dedicated deps service so a macOS-host install can never poison the linux containers (the named volume shadows the host directory):",
    "",
    "```yaml",
    DEPS_CONTAINER_SNIPPET,
    "```",
    "",
    "- Ops/tooling container: add a dedicated service (same image/network as the app, no ports, no Caddy labels) for one-off tooling — migrations, seeds, cron-like jobs — and run it with `hack run <ops-service> <cmd...>` instead of baking tooling into app images or running it on the host.",
    "- Keep images matched to the project runtime version (check `.nvmrc`, `engines`, or the lockfile) so container installs match CI/prod.",
    "- Dev-server host checks: framework dev servers reject unknown hostnames by default — allow the project's `.hack` hosts through (Vite `server.allowedHosts`, Astro/Vike equivalents, Next.js `allowedDevOrigins`, Rails `config.hosts`). Dev-server config only; leave prod builds untouched.",
    '- App-level "is this URL local?" guards (auth callbacks, transactional-email gates, CSRF origin checks) may not recognize `*.hack` as local — extend them to treat `*.hack` as a local dev host, but keep the public-resolvable OAuth alias (`*.hack.gy` by default) OUT of the local allowlist so deployed-environment guards still apply to it. Lock both behaviors in with tests.',
    "- `hack global install` and `hack global trust` need sudo/interactive steps (DNS resolver, CA trust) an agent cannot complete — set the stack up fully, verify with in-container checks or `curl --resolve`, and hand the human the exact global commands to run for browser access.",
  ];
}

function renderRunningThingsPhase(): string[] {
  const section = INSTRUCTION_SECTIONS.find(
    (candidate) => candidate.id === RUNNING_THINGS_SECTION_ID
  );
  const bullets = section ? section.bullets.map((bullet) => `- ${bullet}`) : [];
  return ["## Phase 4 — Running things (decision guide)", "", ...bullets];
}

function renderVerifyPhase(opts: { readonly devHost?: string }): string[] {
  const host = opts.devHost ?? "<dev_host>";
  return [
    "## Phase 5 — Verify (loop until clean)",
    "",
    "- Start: `hack up --detach --json` — the `{ok, data | error: {code, message}}` envelope tells you exactly what failed; fix and retry.",
    "- Status: `hack ps --json` — every expected service must be running (not restarting).",
    `- Routes: \`hack open --json\` lists routable URLs; confirm each one answers (e.g. \`curl -k https://api.${host}\`) or inspect \`hack logs <service> --no-follow --tail 100\`.`,
    "- Iterate: edit compose/config, then `hack restart` and re-check. Use `hack logs --pretty` while debugging.",
    "- Done when `hack doctor` reports no issues and every routable service responds over its Caddy hostname.",
  ];
}

function renderGroundRules(): string[] {
  return [
    "## Ground rules",
    "",
    "- Scripted/agent runs: pass `--no-interactive` (or set `HACK_NO_INTERACTIVE=1`) so commands never block on prompts.",
    "- Treat `.hack/.internal/**` and `.hack/.branch/**` as generated artifacts — never hand-edit them.",
    "- If runtime state looks wrong: `hack doctor`, then `hack doctor --fix` before manual repair.",
    "- Summarize what you configured (services, hostnames, env keys added, remaining gaps) when you finish.",
  ];
}
