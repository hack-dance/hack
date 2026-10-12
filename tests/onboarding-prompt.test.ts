import { expect, test } from "bun:test";

import { INSTRUCTION_SECTIONS } from "../src/agents/instruction-source.ts";
import { renderOnboardingPrompt } from "../src/agents/onboarding-prompt.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";
import {
  extractHackInvocations,
  findGuidanceCommandIssues,
} from "./helpers/cli-guidance-commands.ts";

const NEW_PROJECT_PROMPT = renderOnboardingPrompt({ mode: "new-project" });
const EXISTING_PROJECT_PROMPT = renderOnboardingPrompt({
  mode: "existing-project",
  projectName: "myapp",
  devHost: "myapp.hack",
});

const ALL_PROMPTS = {
  "new-project": NEW_PROJECT_PROMPT,
  "existing-project": EXISTING_PROJECT_PROMPT,
} as const;

test("onboarding prompt renders all phases in both modes", () => {
  for (const prompt of Object.values(ALL_PROMPTS)) {
    expect(prompt).toContain("## Phase 1 — Inventory the repo");
    expect(prompt).toContain("## Phase 2 — Set up hack");
    expect(prompt).toContain("## Phase 3 — Platform nuances");
    expect(prompt).toContain("## Phase 4 — Running things (decision guide)");
    expect(prompt).toContain("## Phase 5 — Verify the requested workflow");
    expect(prompt).toContain("## Ground rules");
  }
});

test("onboarding prompt covers inventory anchors", () => {
  for (const prompt of Object.values(ALL_PROMPTS)) {
    expect(prompt).toContain("package.json");
    expect(prompt).toContain("lockfiles");
    expect(prompt).toContain("`.env*`");
    expect(prompt).toContain("migrations");
  }
});

test("onboarding prompt covers env + secret guidance", () => {
  for (const prompt of Object.values(ALL_PROMPTS)) {
    expect(prompt).toContain("hack env add");
    expect(prompt).toContain("--secret");
    expect(prompt).toContain(
      "never put secret values in an agent prompt, command argument, log, or source control"
    );
    expect(prompt).toContain(
      "hack host exec --env <overlay> --scope <service>"
    );
  }
});

test("onboarding prompt includes the deps-container pattern with a concrete compose snippet", () => {
  for (const prompt of Object.values(ALL_PROMPTS)) {
    expect(prompt).toContain("node_modules:/app/node_modules");
    expect(prompt).toContain("service_completed_successfully");
    expect(prompt).toContain("inside that container environment");
    expect(prompt).toContain("avoids mixing macOS and Linux binaries");
    expect(prompt).toContain("ops/tooling container only when");
  }
});

test("onboarding prompt mirrors the running-things decision guide from the instruction source", () => {
  const section = INSTRUCTION_SECTIONS.find(
    (candidate) => candidate.id === "running-things"
  );
  expect(section).toBeDefined();
  for (const prompt of Object.values(ALL_PROMPTS)) {
    for (const bullet of section?.bullets ?? []) {
      expect(prompt).toContain(bullet);
    }
  }
});

test("onboarding prompt includes the verification loop", () => {
  for (const prompt of Object.values(ALL_PROMPTS)) {
    expect(prompt).toContain("hack up --detach --json");
    expect(prompt).toContain("hack ps --json");
    expect(prompt).toContain("hack open --json");
    expect(prompt).toContain("hack logs");
    expect(prompt).toContain(
      "unrelated optional integrations are not a completion gate"
    );
  }
});

test("modes diverge on bootstrap guidance", () => {
  expect(NEW_PROJECT_PROMPT).toContain("hack init --auto");
  expect(NEW_PROJECT_PROMPT).toContain("stand up hack in this repo");

  expect(EXISTING_PROJECT_PROMPT).toContain("`.hack/` already exists");
  expect(EXISTING_PROJECT_PROMPT).toContain(
    "adopt the existing hack setup in this repo"
  );
  expect(EXISTING_PROJECT_PROMPT).toContain("(project: myapp)");
});

test("known dev_host is threaded into hostname and verification guidance", () => {
  expect(EXISTING_PROJECT_PROMPT).toContain("api.myapp.hack");
  expect(NEW_PROJECT_PROMPT).toContain("api.<project>.hack");
});

test("every hack command path and long flag referenced by the prompt exists in CLI_SPEC", () => {
  for (const [mode, prompt] of Object.entries(ALL_PROMPTS)) {
    expect(
      extractHackInvocations(prompt).length,
      `mode "${mode}" has no hack invocations to validate`
    ).toBeGreaterThan(0);
    expect(
      findGuidanceCommandIssues({ cli: CLI_SPEC, rendered: prompt }),
      `mode "${mode}" references unknown hack commands or flags`
    ).toEqual([]);
  }
});

test("onboarding preserves trust and ownership without imposing a full migration", () => {
  for (const prompt of Object.values(ALL_PROMPTS)) {
    expect(prompt).toContain("partial adoption is a valid end state");
    expect(prompt).toContain("may be exited with code 0");
    expect(prompt).toContain("normal TLS verification");
    expect(prompt).toContain("let the user complete native prompts");
    expect(prompt).toContain(
      "deletion or broader migration requires authorization"
    );
    expect(prompt).toContain("Do not broadly classify");
    expect(prompt).not.toContain("curl -k");
    expect(prompt).not.toMatch(/`hack (?:node|remote|gateway|dispatch)\b/);
  }
});

test("new-project guidance uses hack.local without rewriting existing host examples", () => {
  expect(NEW_PROJECT_PROMPT).toContain("<project>.hack.local");
  expect(EXISTING_PROJECT_PROMPT).toContain("dev_host (myapp.hack)");
  expect(NEW_PROJECT_PROMPT).toContain("public-resolvable `*.hack.gy`");
});

test("deps guidance uses a locked install and treats lockfile failure as a diagnosis", () => {
  for (const prompt of Object.values(ALL_PROMPTS)) {
    expect(prompt).toContain(
      'command: ["bun", "install", "--frozen-lockfile"]'
    );
    expect(prompt).not.toContain('command: ["bun", "install"]');
    expect(prompt).toContain("pnpm install --frozen-lockfile");
    expect(prompt).toContain("yarn install --immutable");
    expect(prompt).toContain("npm ci");
    expect(prompt).toContain("A lockfile mismatch is something to diagnose");
    expect(prompt).toContain(
      "do not drop the flag or regenerate the lockfile to get a green run"
    );
  }
});

test("deps guidance references the dependency cache labels and optional locked-v1 protocol", () => {
  for (const prompt of Object.values(ALL_PROMPTS)) {
    expect(prompt).toContain("hack.dependencies.cache-volume: node_modules");
    expect(prompt).toContain("hack.dependencies.lockfiles: bun.lock");
    expect(prompt).toContain("hack.dependencies.cache-protocol: locked-v1");
    expect(prompt).toContain("they select a volume but do not serialize");
  }
});

test("inventory guidance covers bun.lock, nested lockfiles, non-JS runtimes and pins", () => {
  for (const prompt of Object.values(ALL_PROMPTS)) {
    expect(prompt).toContain("`bun.lock` or legacy `bun.lockb`");
    expect(prompt).toContain("in each workspace package");
    expect(prompt).toContain("do not delete or regenerate a lockfile");
    for (const manifest of [
      "Cargo.toml",
      "go.mod",
      "pyproject.toml",
      "uv.lock",
      "poetry.lock",
      "requirements.txt",
      "Gemfile.lock",
      "mix.exs",
      "*.csproj",
      "*.sln",
    ]) {
      expect(prompt).toContain(manifest);
    }
    for (const pin of ["`.nvmrc`", "`.tool-versions`", "`mise.toml`"]) {
      expect(prompt).toContain(pin);
    }
  }
});

test("setup guidance resumes from existing config and offers toolchain-only adoption", () => {
  for (const prompt of Object.values(ALL_PROMPTS)) {
    expect(prompt).toContain("Resume before starting over");
    expect(prompt).toContain(
      "continue from there instead of re-scaffolding or redoing finished phases"
    );
    expect(prompt).toContain("backing-services-only, or toolchain-only");
    expect(prompt).toContain(
      "`hack run --profile <profile> <service> -- <cmd>`"
    );
    expect(prompt).toContain(
      "Neither partial shape needs an always-on app service"
    );
  }
});

test("verification covers persistent data across down/up and reruns", () => {
  for (const prompt of Object.values(ALL_PROMPTS)) {
    expect(prompt).toContain(
      "survives `hack down` followed by `hack up --detach --json`"
    );
    expect(prompt).toContain("rerunning setup steps");
    expect(prompt).toContain("Do not delete volumes to get a clean pass");
  }
});

test("ground rules forbid instruction-file injection and require reporting discovery limits", () => {
  for (const prompt of Object.values(ALL_PROMPTS)) {
    const groundRules = prompt.slice(prompt.indexOf("## Ground rules"));
    expect(groundRules).toContain(
      "Never create or modify AGENTS.md, CLAUDE.md, editor or agent rule files, or repository copies of agent skills unless the user asks."
    );
    expect(groundRules).toContain("Report discovery limits you hit");
    expect(groundRules).toContain("the agent client CLI was missing");
    expect(groundRules).toContain("a non-interactive run");
    expect(groundRules).toContain("no-shell `hack-init` MCP prompt");
    expect(groundRules).toContain("defaults to existing-project mode");
  }
});
