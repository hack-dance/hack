import { expect, test } from "bun:test";

test("ordinary startup and doctor do not invoke integration inventory or refresh", async () => {
  const startup = await Bun.file("index.ts").text();
  const doctor = await Bun.file("src/commands/doctor.ts").text();
  const prime = await Bun.file("src/commands/agent.ts").text();
  for (const source of [startup, doctor, prime]) {
    expect(source).not.toContain("inspectAgentIntegrationFreshness(");
    expect(source).not.toContain("runSetupSyncScope(");
    expect(source).not.toContain("checkAgentIntegrations(");
  }
  expect(doctor.match(/inspectDoctorAgentIntegrations\(/g)).toHaveLength(1);
  expect(prime).not.toContain("integration-sync.ts");
  expect(await Bun.file("src/cli/integration-sync.ts").exists()).toBe(false);
});
