/** Job and step gates in ci.yml. Shared output names union their consumers. */
export const CI_JOB_POLICY = [
  {
    job: "config-compiler",
    output: "compiler_hosts",
    tier: "compiler",
    // build:release enumerates these rather than naming each file.
    trees: ["binaries/gum/", "packages/config-compiler/generated/"],
  },
  {
    job: "config-compiler",
    output: "compiler_rust",
    tier: "compilerRust",
    steps: true,
  },
  { job: "runtime-core", output: "runtime_core", tier: "candidate" },
  {
    job: "state-models",
    output: "state_models",
    tier: "models",
    // The runner enumerates model data and the helper suite dynamically.
    trees: ["tests/models/", ".ai/skills/hack-repo-tla/"],
    files: ["scripts/lib/tla-runtime-models.ts"],
  },
  {
    job: "runtime-images",
    output: "docker_suite",
    tier: "docker",
    modifiers: ["draft"],
  },
  {
    job: "docker-e2e-shard",
    // recipe-examples.test.ts enumerates and copies these checkout directories.
    trees: ["examples/configs/", "examples/recipes/", "docs/recipes/"],
    output: "docker_suite",
    tier: "docker",
    modifiers: ["draft"],
  },
  {
    job: "linux-process-lifetime",
    output: "docker_suite",
    tier: "docker",
    modifiers: ["draft"],
  },
  {
    job: "docs-site",
    output: "docs_site",
    tier: "docs",
    steps: true,
    // The site preparation and build enumerate the corpus and site sources.
    trees: ["docs/", "site/", "scripts/docs/"],
    files: ["README.md"],
  },
  {
    job: "test-shard",
    output: "build_smoke",
    tier: "build",
    steps: true,
    trees: ["binaries/gum/", "packages/config-compiler/generated/"],
  },
  {
    job: "test-shard",
    output: "suite",
    always:
      "Unit qualification always runs on PRs. The unit selector supplies the files.",
  },
  {
    job: "test-shard",
    output: "defer_macos",
    steps: true,
    always: "The step reports deferred tests and does not qualify inputs.",
  },
  {
    job: "test-focus",
    output: "test_focus",
    steps: true,
    always:
      "The check always reports. Legacy focus steps are replaced by unit shards in the PR planner.",
  },
] as const;

type DerivedRow = Extract<(typeof CI_JOB_POLICY)[number], { tier: string }>;
export type Tier = DerivedRow["tier"];
export const DERIVED_JOB_ROWS = CI_JOB_POLICY.filter(
  (row): row is DerivedRow => "tier" in row
);
export const JOB_TIERS = [...new Set(DERIVED_JOB_ROWS.map((row) => row.tier))];

/** The coverage guard compares these keys to the actual workflow conditions. */
export function workflowGateKey(
  job: string,
  output: string,
  steps: boolean
): string {
  return `${job}:${steps ? "step" : "job"}:${output}`;
}
