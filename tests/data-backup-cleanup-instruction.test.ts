import { expect, test } from "bun:test";
import { cleanupInstruction } from "../src/lib/data-backup-cleanup-instruction.ts";

/**
 * The only recovery instruction for a container whose create Hack could not
 * reconcile is `hack data cleanup --nonce <nonce>`: no raw docker command,
 * and no engine endpoint (a DOCKER_HOST or a context endpoint) in any form.
 */
const NONCE = "0123456789abcdef0123456789abcdef";

test("the instruction is hack data cleanup, never a raw docker command", () => {
  for (const hackCommand of [
    undefined,
    `hack data cleanup --branch=feature-x --nonce=${NONCE}`,
  ]) {
    const instruction = cleanupInstruction({ nonce: NONCE, hackCommand });
    expect(instruction).toContain("hack data cleanup");
    expect(instruction).toContain(`--nonce=${NONCE}`);
    expect(instruction).not.toContain("docker ps");
    expect(instruction).not.toContain("docker rm");
    expect(instruction).not.toContain("xargs");
    expect(instruction).not.toContain("DOCKER_HOST");
    expect(instruction).not.toContain("--context");
  }
});

test("no endpoint value can reach the instruction", () => {
  // The instruction takes no engine input at all: whatever the managed env
  // selects (here recognizable stand-ins), it cannot be printed.
  const endpoints = [
    "tcp://10.0.0.5:2376",
    "ssh://deploy:hunter2-canary@build.example:22",
    "unix:///run/user/canary-55/docker.sock",
  ];
  const instruction = cleanupInstruction({ nonce: NONCE });
  for (const endpoint of endpoints) {
    expect(instruction).not.toContain(endpoint);
  }
  expect(instruction).toBe(`hack data cleanup --nonce=${NONCE}`);
});
