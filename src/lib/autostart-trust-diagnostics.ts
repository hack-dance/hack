import { autostartServicePath } from "../daemon/autostart.ts";
import { assertAutostartCheckoutTrusted } from "./autostart-checkout-trust.ts";
import { assertAutostartDockerConfigTrusted } from "./autostart-docker-trust.ts";
import { assertAutostartExecutablePathTrusted } from "./autostart-executable-trust.ts";
import { autostartStartPolicyRefusal } from "./autostart-start-policy.ts";
import type { RegisteredProject } from "./projects-registry.ts";

/** File-only doctor observation; never executes helpers or repairs permissions. */
export async function autostartTrustWarnings(opts: {
  readonly projects: readonly RegisteredProject[];
  readonly home: string;
  readonly executablePath?: string;
}): Promise<readonly string[]> {
  const warnings = new Set<string>();
  for (const project of opts.projects) {
    if (!project.autostart) {
      continue;
    }
    try {
      assertAutostartCheckoutTrusted(project);
      const reason = await autostartStartPolicyRefusal(project);
      if (reason) {
        warnings.add(reason);
      }
    } catch {
      warnings.add("checkout_untrusted");
    }
  }
  try {
    assertAutostartDockerConfigTrusted({ home: opts.home });
  } catch {
    warnings.add("docker_config_untrusted");
  }
  try {
    await assertAutostartExecutablePathTrusted({
      path:
        opts.executablePath ??
        autostartServicePath({ home: opts.home, platform: process.platform }),
    });
  } catch {
    warnings.add("executable_path_untrusted");
  }
  return [...warnings];
}
