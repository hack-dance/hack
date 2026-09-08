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
  "      image: oven/bun:1 # replace with the repo-pinned runtime image",
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
      ? "Your goal: make the requested local development workflow work with Hack and verify it. Full containerization or backing-services-only adoption are both valid."
      : "Your goal: complete the requested parts of this project's Hack setup and verify the chosen container and host workflows.";
  return [
    "You are a coding agent setting this repository up to run with the hack CLI (local-first runtime orchestration: compose, DNS/TLS, logs, env).",
    goal,
    "Use the phases relevant to the requested scope; infer routine details from existing config and ask only for unresolved blockers. Prefer `hack` commands over raw `docker` / `docker compose`. Run `hack help <cmd>` when unsure about flags.",
  ];
}

function renderInventoryPhase(): string[] {
  return [
    "## Phase 1 — Inventory the repo",
    "",
    "- Read the root package.json, workspace globs, and lockfiles to identify the package manager and monorepo layout.",
    "- Identify runnable services (web, api, workers): dev/start scripts, framework configs, and the ports they listen on.",
    "- Detect databases, caches, and queues from code and config: ORM schemas (prisma/drizzle), migration dirs, existing Dockerfiles and compose files.",
    "- Inventory env variable names from `.env*` example files, configuration, compose, Dockerfiles, and CI references without printing or copying secret values. Preserve the existing package manager, runtime, and credential flow.",
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
    "- Define one compose service per process chosen for containerization in `.hack/docker-compose.yml`. HTTP services need the Caddy labels (`caddy`, `caddy.reverse_proxy`, `caddy.tls=internal`) and the `hack-dev` network to be routable.",
    `- Design hostnames: the primary app answers on dev_host (${devHostExample}); every other routable service gets a subdomain (\`api.${devHostExample}\`, \`grafana.${devHostExample}\`, ...). Set dev_host in \`.hack/hack.config.json\`.`,
    "- Migrate only the env entries required for the authorized setup. Use `hack env add <KEY> <value>` for non-secret values. For secrets, use an authorized secret-manager/injection path or let the user enter them through `hack env add <KEY> --secret`; never put secret values in an agent prompt, command argument, log, or source control.",
    "- Verify container env injection and host commands through `hack host exec` before treating any old env file as superseded. Preserve files still needed by other workflows; deletion or broader migration requires authorization.",
    "- Encode required host-side setup (tunnels, proxies, credential bootstrap) in `.hack/hack.config.json` under `startup`/`lifecycle` — not in ad-hoc terminal instructions.",
  ];
}

function renderPlatformPhase(): string[] {
  return [
    "## Phase 3 — Platform nuances (macOS host, linux containers)",
    "",
    "- For Linux-container Node/Bun services with native dependencies, install dependencies inside that container environment. A named `node_modules` volume plus a one-shot deps service avoids mixing macOS and Linux binaries. Adapt this example to the repo-pinned runtime and package manager:",
    "",
    "```yaml",
    DEPS_CONTAINER_SNIPPET,
    "```",
    "",
    "- Add an ops/tooling container only when tooling requires the container runtime or network. Reuse an existing service when suitable, or use `hack host exec` for host tooling. Run migrations and seeds only for the authorized development target.",
    "- Keep images matched to the project runtime version (check `.nvmrc`, `engines`, or the lockfile) so container installs match CI/prod.",
    "- Dev-server host checks: framework dev servers reject unknown hostnames by default — allow the project's `.hack` hosts through (Vite `server.allowedHosts`, Astro/Vike equivalents, Next.js `allowedDevOrigins`, Rails `config.hosts`). Dev-server config only; leave prod builds untouched.",
    "- If a required dev route fails an origin or callback check, inspect the existing security policy and configure only the exact authorized development origins. Do not broadly classify `*.hack` or the public-resolvable `*.hack.gy` alias as trusted, bypass CSRF checks, or disable transactional-email/publishing gates. Test any changed allowlist and its rejected origins.",
    "- Global DNS and CA setup may require native sudo/trust approval. Attempt only global actions covered by the request, let the user complete native prompts, and continue independent project work while blocked. Report HTTP reachability and certificate trust separately; do not disable verification to claim success.",
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
    "## Phase 5 — Verify the requested workflow",
    "",
    "- Start: `hack up --detach --json` — the `{ok, data | error: {code, message}}` envelope tells you exactly what failed; fix and retry.",
    "- Status: `hack ps --json` should show expected long-running services healthy/running. Successful dependency installers and other one-shot services may be exited with code 0.",
    `- Routes: use \`hack open --json\` to find the actual routed URLs for ${host}, then check those URLs with normal TLS verification. Use finite \`hack logs <service> --no-follow --tail 100\` reads for diagnosis.`,
    "- Iterate on the failing behavior and restart only affected services where possible. Use finite log reads and stop when the requested acceptance criteria pass.",
    "- Finish when the requested services and host workflows work and their routes respond with the expected trust behavior. Classify remaining doctor warnings; unrelated optional integrations are not a completion gate.",
  ];
}

function renderGroundRules(): string[] {
  return [
    "## Ground rules",
    "",
    "- Scripted/agent runs: pass `--no-interactive` (or set `HACK_NO_INTERACTIVE=1`) so commands never block on prompts.",
    "- Treat `.hack/.internal/**` and `.hack/.branch/**` as generated artifacts — never hand-edit them.",
    "- Inspect unexpected state with `hack doctor` and apply only authorized repairs. Preserve runtime ownership, native approval, and destructive-cleanup gates.",
    "- Summarize what you configured (services, hostnames, env keys added, remaining gaps) when you finish.",
  ];
}
