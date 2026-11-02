import {
  findProjectContext,
  findRepoRootForInit,
  readProjectConfig,
  readProjectDevHost,
} from "../lib/project.ts";
import {
  buildInitAssistantReport,
  type InitAssistantReport,
  renderInitAssistantInventory,
} from "./init-assistant.ts";
import { INSTRUCTION_SECTIONS } from "./instruction-source.ts";

/**
 * Single source of truth for the agent-assisted onboarding prompt.
 *
 * Every entry point builds its prompt here, from one repo inventory, so the
 * content can never fork (keep this list current):
 * - `hack init --with claude|codex` (CLI handoff after init),
 * - `hack agent onboard` (CLI print),
 * - `hack agent init` (CLI print or client handoff),
 * - the `hack-init` MCP prompt (no-shell clients).
 *
 * Contract: an entry point calls {@link buildOnboardingPrompt} (or, only for
 * the MCP prompt without a `repoRoot`, {@link onboardingContextWithoutInventory}
 * plus {@link renderOnboardingPrompt}). The rendered prompt is exactly
 * `frame.before + core + frame.after`: the core comes from
 * {@link renderOnboardingCore} and is byte-identical for every entry point on
 * the same repo; {@link renderOnboardingFrame} owns the only per-entry-point
 * text, and that text never repeats repo values.
 *
 * The `/hack-init` agent-side skill and the copy-paste bootstrap block in
 * `docs/guides/agent-first-setup.md` are thin pointers to these entry points.
 */

export type OnboardingMode = "new-project" | "existing-project";

const RUNNING_THINGS_SECTION_ID = "running-things";

const DEPS_CONTAINER_SNIPPET = [
  "  services:",
  "    deps:",
  "      image: oven/bun:1 # replace with the repo-pinned runtime image",
  "      platform: linux/arm64 # the installer's actual target platform",
  "      working_dir: /app",
  "      volumes:",
  "        - ..:/app",
  "        - node_modules:/app/node_modules",
  "      # locked install; adapt: pnpm install --frozen-lockfile | yarn install --immutable | npm ci",
  '      command: ["bun", "install", "--frozen-lockfile"]',
  "      labels: # optional: share the volume across lockfile-compatible worktrees",
  "        hack.dependencies.cache-volume: node_modules",
  "        hack.dependencies.lockfiles: bun.lock,package.json",
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

/** Why no pre-computed inventory is in the prompt. Closed set; value-free. */
export type OnboardingInventoryGap = "no-repo-root";

/** The repo inventory every entry point embeds, or the closed reason it is absent. */
export type OnboardingInventory =
  | { readonly status: "collected"; readonly report: InitAssistantReport }
  | { readonly status: "not-run"; readonly reason: OnboardingInventoryGap };

/** Everything the core prompt depends on. Nothing else may vary it. */
export type OnboardingContext = {
  readonly mode: OnboardingMode;
  readonly projectName?: string;
  readonly devHost?: string;
  readonly inventory: OnboardingInventory;
};

/**
 * The entry point that asked for the prompt. It selects the framing only;
 * it never changes the core.
 *
 * `init-with.scaffold` says whether this `hack init` run wrote `.hack/`
 * (`created`) or found it already present and skipped init (`existing`).
 */
export type OnboardingEntryPoint =
  | { readonly kind: "init-with"; readonly scaffold: "created" | "existing" }
  | { readonly kind: "agent-onboard" }
  | { readonly kind: "agent-init" }
  | { readonly kind: "mcp-hack-init" };

/** Per-entry-point text placed around the core. */
export type OnboardingFrame = {
  readonly before: string;
  readonly after: string;
};

const INVENTORY_GAP_TEXT: Readonly<Record<OnboardingInventoryGap, string>> = {
  "no-repo-root": "this `hack-init` MCP prompt request named no `repoRoot`",
};

/**
 * Inventory the repo at or above `startDir` and derive the onboarding context.
 *
 * The repo root is the enclosing hack project root when one exists, otherwise
 * the `hack init` repo root. Mode follows repo state alone: `existing-project`
 * when a `.hack/` project is found (project name and dev host then come from
 * its config), `new-project` otherwise. Errors from project discovery (for
 * example a native project marker) propagate unchanged.
 */
export async function collectOnboardingContext(opts: {
  readonly startDir: string;
}): Promise<OnboardingContext> {
  const project = await findProjectContext(opts.startDir);
  const repoRoot = project
    ? project.projectRoot
    : await findRepoRootForInit(opts.startDir);
  const report = await buildInitAssistantReport({ repoRoot });
  const inventory: OnboardingInventory = { status: "collected", report };
  if (!report.projectContext) {
    return { mode: "new-project", inventory };
  }

  const config = await readProjectConfig(report.projectContext);
  const devHost = await readProjectDevHost(report.projectContext);
  return {
    mode: "existing-project",
    ...(config.name ? { projectName: config.name } : {}),
    ...(devHost ? { devHost } : {}),
    inventory,
  };
}

/**
 * Context for a request that names no repo (the `hack-init` MCP prompt
 * without `repoRoot`). The core then states that no inventory was run.
 */
export function onboardingContextWithoutInventory(opts: {
  readonly mode: OnboardingMode;
  readonly projectName?: string;
  readonly devHost?: string;
  readonly reason: OnboardingInventoryGap;
}): OnboardingContext {
  return {
    mode: opts.mode,
    ...(opts.projectName ? { projectName: opts.projectName } : {}),
    ...(opts.devHost ? { devHost: opts.devHost } : {}),
    inventory: { status: "not-run", reason: opts.reason },
  };
}

/**
 * Collect the repo inventory and render the framed prompt for one entry point.
 * This is the builder every CLI entry point calls.
 */
export async function buildOnboardingPrompt(opts: {
  readonly startDir: string;
  readonly entryPoint: OnboardingEntryPoint;
}): Promise<string> {
  const context = await collectOnboardingContext({ startDir: opts.startDir });
  return renderOnboardingPrompt({ context, entryPoint: opts.entryPoint });
}

/** Render `frame.before + core + frame.after` for one entry point. */
export function renderOnboardingPrompt(opts: {
  readonly context: OnboardingContext;
  readonly entryPoint: OnboardingEntryPoint;
}): string {
  const frame = renderOnboardingFrame({ entryPoint: opts.entryPoint });
  return `${frame.before}${renderOnboardingCore({ context: opts.context })}${frame.after}`;
}

/**
 * The only per-entry-point text. It is fixed per entry point and never
 * repeats repo values, so it cannot carry inventory drift.
 */
export function renderOnboardingFrame(opts: {
  readonly entryPoint: OnboardingEntryPoint;
}): OnboardingFrame {
  const entryPoint = opts.entryPoint;
  switch (entryPoint.kind) {
    case "init-with":
      return {
        before:
          entryPoint.scaffold === "created"
            ? "Handoff from `hack init --with`: this run scaffolded `.hack/`. Treat the generated config as a starting point and refine it instead of re-running `hack init`.\n\n"
            : "Handoff from `hack init --with`: `.hack/` already existed, so init was skipped and nothing was scaffolded.\n\n",
        after: "",
      };
    case "agent-init":
      return {
        before: "",
        after: "Need dependency/ops patterns? Run `hack agent patterns`.\n",
      };
    case "agent-onboard":
    case "mcp-hack-init":
      return { before: "", after: "" };
    default:
      return assertNeverEntryPoint(entryPoint);
  }
}

/**
 * Render the canonical, entry-point-independent onboarding prompt.
 *
 * Discovery first: the pre-computed repo inventory (or the closed reason it
 * is absent) precedes the phases, which walk an agent through confirming the
 * inventory, standing hack up (or resuming/adopting an existing `.hack/`
 * setup), platform nuances (locked deps installs, cache labels, ops
 * containers), the running-things decision guide, and a verification loop
 * that includes data persistence. Ground rules forbid injecting agent
 * instruction files and require the agent to report discovery limits.
 */
export function renderOnboardingCore(opts: {
  readonly context: OnboardingContext;
}): string {
  const { context } = opts;
  const lines: string[] = [];

  lines.push(renderHeader(context));
  lines.push("");
  lines.push(...renderIntro(context));
  lines.push("");
  lines.push(...renderInventorySection(context.inventory));
  lines.push("");
  lines.push(...renderInventoryPhase());
  lines.push("");
  lines.push(...renderSetupPhase(context));
  lines.push("");
  lines.push(...renderPlatformPhase());
  lines.push("");
  lines.push(...renderRunningThingsPhase());
  lines.push("");
  lines.push(...renderVerifyPhase(context));
  lines.push("");
  lines.push(...renderGroundRules());
  lines.push("");

  return lines.join("\n");
}

function assertNeverEntryPoint(value: never): never {
  throw new Error(`Unknown onboarding entry point: ${String(value)}`);
}

function renderInventorySection(inventory: OnboardingInventory): string[] {
  const heading = ["## Repo inventory (pre-computed by Hack)", ""];
  if (inventory.status === "not-run") {
    return [
      ...heading,
      `- Not run: ${INVENTORY_GAP_TEXT[inventory.reason]}. Inventory the repo yourself in Phase 1 and report that no pre-computed inventory was available.`,
    ];
  }
  return [
    ...heading,
    "Hack read file names and manifest keys to build this inventory. Confirm and extend it in Phase 1; an absent signal is not an absent requirement.",
    "",
    ...renderInitAssistantInventory({ report: inventory.report }),
  ];
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
      ? "Your goal: make the requested local development workflow work with Hack and verify it. Full containerization, backing-services-only, or toolchain-only adoption are all valid."
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
    "- Start from the pre-computed inventory above: confirm each detected signal, check every listed discovery limitation yourself, and report the ones that remain. When no inventory was run, do the full inventory below.",
    "- Read the root package.json (including its `packageManager` and `engines` keys), workspace globs, and lockfiles (`bun.lock` or legacy `bun.lockb`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`) at the root and in each workspace package to identify the package manager and monorepo layout. Lockfiles from more than one package manager, or a nested lockfile inside a workspace package, are a conflict to resolve with the human — do not delete or regenerate a lockfile to pick one.",
    "- Note non-JS manifests and lockfiles (Cargo.toml/Cargo.lock, go.mod, pyproject.toml/uv.lock/poetry.lock/requirements.txt, Gemfile.lock, mix.exs/mix.lock, *.csproj/*.sln) and runtime pins (`.nvmrc`, `.tool-versions`, `mise.toml`, `engines`, `packageManager`) by name. Find those services' entrypoints, ports, and setup steps from their build files and docs; pinned versions decide the container images and tools you use.",
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
  // An existing setup without a configured dev_host must not be described
  // with the new-project default host.
  const devHostExample =
    opts.devHost ??
    (opts.mode === "new-project" ? "<project>.hack.local" : "<dev_host>");
  const bootstrap =
    opts.mode === "new-project"
      ? "- Scaffold config: run `hack init --auto` (add `--name <slug>` / `--dev-host <host>` when the defaults are wrong). If `.hack/` already exists, edit the config instead of re-running init."
      : "- `.hack/` already exists: review `.hack/hack.config.json` and `.hack/docker-compose.yml` and refine them; do not re-run `hack init` unless the user asks for a reset.";

  return [
    "## Phase 2 — Set up hack",
    "",
    "- Resume before starting over: if `.hack/hack.config.json` already exists from an earlier run or a partial setup, keep it. Run `hack doctor` and `hack up --detach --json`, find the first phase whose result is missing or failing, and continue from there instead of re-scaffolding or redoing finished phases.",
    bootstrap,
    "- Choose the adoption shape: full containerization, backing-services-only, or toolchain-only. Backing-services-only composes db/queue/cache and keeps app dev servers on the host pointed at the routed services. Toolchain-only defines one-shot tool services behind a Compose profile that pin the language tools and dependency caches, run with `hack run --profile <profile> <service> -- <cmd>`. Neither partial shape needs an always-on app service. Prefer a partial shape when the inventory shows heavy native toolchains (.NET, large native builds) or the human prefers host dev servers — ask the human when it's ambiguous; partial adoption is a valid end state, not a fallback to fix later.",
    "- Check for reuse before authoring new services: if the repo already containerizes for prod (existing Dockerfiles/compose with build contexts, runtime-config injection points like an nginx-served runtime-config.js), prefer reusing those images/contexts with minimal glue over hand-authoring new dev-mode services from scratch.",
    "- Define one compose service per process chosen for containerization in `.hack/docker-compose.yml`. HTTP services need the Caddy labels (`caddy`, `caddy.reverse_proxy`, `caddy.tls=internal`) and the `hack-dev` network to be routable.",
    `- Design hostnames: the primary app answers on dev_host (${devHostExample}); every other routable service gets a subdomain (\`api.${devHostExample}\`, \`grafana.${devHostExample}\`, ...). Set dev_host in \`.hack/hack.config.json\`.`,
    "- Migrate only the env entries required for the authorized setup. Use `hack env add <KEY> <value>` for non-secret values. For secrets, pipe the value from an authorized secret manager with `<secret-source> | hack env add <KEY> --secret --value-stdin`, or let the user enter it at the hidden prompt of `hack env add <KEY> --secret`; never put secret values in an agent prompt, command argument, log, or source control.",
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
    "- Keep the locked install: `bun install --frozen-lockfile`, `pnpm install --frozen-lockfile`, `yarn install --immutable`, or `npm ci`. A lockfile mismatch is something to diagnose (runtime or package-manager version drift, a stale lockfile, the wrong package manager); do not drop the flag or regenerate the lockfile to get a green run unless the human asks.",
    "- The optional `hack.dependencies.cache-volume` and `hack.dependencies.lockfiles` labels key the dependency volume by lockfile and runtime fingerprint so compatible worktrees share it; they select a volume but do not serialize installers. Opt into `hack.dependencies.cache-protocol: locked-v1` only for an immutable, credential-free install payload (see the dependency cache protocol guide, `docs/guides/dependency-cache-protocol.md` in the Hack repository).",
    "- Add an ops/tooling container only when tooling requires the container runtime or network. Reuse an existing service when suitable, or use `hack host exec` for host tooling. Run migrations and seeds only for the authorized development target.",
    "- Keep images matched to the project runtime version (check `.nvmrc`, `.tool-versions`, `mise.toml`, `engines`, `packageManager`, or the lockfile) so container installs match CI/prod.",
    "- Dev-server host checks: framework dev servers reject unknown hostnames by default — allow the project's configured development hosts (new default `.hack.local`, with legacy `.hack` supported) through (Vite `server.allowedHosts`, Astro/Vike equivalents, Next.js `allowedDevOrigins`, Rails `config.hosts`). Dev-server config only; leave prod builds untouched.",
    "- If a required dev route fails an origin or callback check, inspect the existing security policy and configure only the exact authorized development origins. Do not broadly classify `*.hack.local`, legacy `*.hack`, or the public-resolvable `*.hack.gy` alias as trusted, bypass CSRF checks, or disable transactional-email/publishing gates. Test any changed allowlist and its rejected origins.",
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
    "- Persistence: confirm persistent data (database rows, uploads, named volumes) survives `hack down` followed by `hack up --detach --json`, and that rerunning setup steps (dependency installs, migrations, seeds) is safe and neither duplicates nor wipes data. Do not delete volumes to get a clean pass.",
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
    "- Never create or modify AGENTS.md, CLAUDE.md, editor or agent rule files, or repository copies of agent skills unless the user asks. Onboarding configures the runtime; it does not install agent instructions.",
    "- Report discovery limits you hit: the agent client CLI was missing (Hack printed this prompt instead of launching a session), a non-interactive run (nothing was spawned or prompted), the inventory's remaining discovery limitations, or a `hack-init` MCP prompt request without `repoRoot` (it defaults to existing-project mode with no repo inventory — confirm whether `.hack/` exists and inventory the repo yourself).",
    "- Summarize what you configured (services, hostnames, env keys added, remaining gaps) when you finish.",
  ];
}
