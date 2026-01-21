import { spawn } from "node:child_process";

/**
 *
 * Ops script for running commands in the ops container.
 *
 * Usage:
 *   bun run ops --command <cmd...>
 *   bun run ops -- <cmd...>
 * Examples:
 *   bun run ops --command bun run db:push
 *   bun run ops -- bun scripts/generate-something.ts
 *
 */
const args = process.argv.slice(2);

const extractCommand = (input: string[]) => {
  if (input.includes("--help") || input.includes("-h")) {
    return { command: null };
  }

  const flagIndex = input.findIndex(
    (item) => item === "--command" || item === "-c"
  );
  if (flagIndex >= 0) {
    return { command: input.slice(flagIndex + 1) };
  }

  const flagValue = input.find((item) => item.startsWith("--command="));
  if (flagValue) {
    const value = flagValue.slice("--command=".length);
    return { command: value ? [value] : [] };
  }

  const doubleDashIndex = input.indexOf("--");
  if (doubleDashIndex >= 0) {
    return { command: input.slice(doubleDashIndex + 1) };
  }

  return { command: input.length > 0 ? input : null };
};

const { command } = extractCommand(args);

if (!command || command.length === 0) {
  process.exit(1);
}

const commandString = command.join(" ");
const dockerArgs = [
  "compose",
  "-f",
  ".hack/docker-compose.yml",
  "--profile",
  "ops",
  "run",
  "--rm",
  "db-ops",
  "sh",
  "-lc",
  `cd /app && ${commandString}`,
];

const child = spawn("docker", dockerArgs, { stdio: "inherit" });

child.once("exit", (code) => {
  process.exit(code ?? 0);
});

child.once("error", (err) => {
  console.error(err);
  process.exit(1);
});
