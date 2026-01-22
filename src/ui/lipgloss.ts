type LipglossModule = typeof import("@charmland/lipgloss");

let cached: LipglossModule | null = null;
let failed = false;

export async function loadLipgloss(): Promise<LipglossModule | null> {
  if (cached) {
    return cached;
  }
  if (failed) {
    return null;
  }

  try {
    const mod = await import("@charmland/lipgloss");
    if (!verifyLipgloss(mod)) {
      failed = true;
      return null;
    }
    cached = mod;
    return cached;
  } catch {
    failed = true;
    return null;
  }
}

function verifyLipgloss(mod: LipglossModule): boolean {
  try {
    const style = new mod.Style();
    style.render("ok");
    return true;
  } catch {
    return false;
  }
}
