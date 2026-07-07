import { expect, test } from "bun:test";

import { INSTRUCTION_SECTIONS } from "../src/agents/instruction-source.ts";
import { renderOnboardingPrompt } from "../src/agents/onboarding-prompt.ts";
import { CLI_SPEC } from "../src/cli/spec.ts";

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

const TOP_LEVEL_COMMANDS: ReadonlySet<string> = new Set(
  CLI_SPEC.commands.map((command) => command.name)
);

const BACKTICK_SEGMENT_PATTERN = /`([^`]+)`/g;

function extractHackSubcommandTokens(rendered: string): string[] {
  const tokens: string[] = [];
  for (const match of rendered.matchAll(BACKTICK_SEGMENT_PATTERN)) {
    const segment = (match[1] ?? "").trim();
    if (!(segment === "hack" || segment.startsWith("hack "))) {
      continue;
    }
    const first = segment.slice("hack ".length).trim().split(/\s+/)[0] ?? "";
    if (first.length === 0 || first.startsWith("-") || first.startsWith("<")) {
      continue;
    }
    for (const part of first.split("/")) {
      if (part.length > 0) {
        tokens.push(part);
      }
    }
  }
  return tokens;
}

test("onboarding prompt renders all phases in both modes", () => {
  for (const prompt of Object.values(ALL_PROMPTS)) {
    expect(prompt).toContain("## Phase 1 — Inventory the repo");
    expect(prompt).toContain("## Phase 2 — Set up hack");
    expect(prompt).toContain("## Phase 3 — Platform nuances");
    expect(prompt).toContain("## Phase 4 — Running things (decision guide)");
    expect(prompt).toContain("## Phase 5 — Verify (loop until clean)");
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
    expect(prompt).toContain("Never commit plaintext secrets");
    expect(prompt).toContain(
      "hack host exec --env <overlay> --scope <service>"
    );
  }
});

test("onboarding prompt includes the deps-container pattern with a concrete compose snippet", () => {
  for (const prompt of Object.values(ALL_PROMPTS)) {
    expect(prompt).toContain("node_modules:/app/node_modules");
    expect(prompt).toContain("service_completed_successfully");
    expect(prompt).toContain("inside linux containers");
    expect(prompt).toContain("macOS-host install can never poison");
    expect(prompt).toContain("Ops/tooling container");
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
    expect(prompt).toContain("`hack doctor` reports no issues");
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

test("every hack subcommand referenced by the prompt exists in CLI_SPEC", () => {
  for (const [mode, prompt] of Object.entries(ALL_PROMPTS)) {
    const unknown = extractHackSubcommandTokens(prompt).filter(
      (token) => !TOP_LEVEL_COMMANDS.has(token)
    );
    expect(
      unknown,
      `mode "${mode}" references unknown hack subcommands`
    ).toEqual([]);
  }
});
