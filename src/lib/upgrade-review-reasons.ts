export const UPGRADE_REVIEW_REASONS: Readonly<Record<string, string>> = {
  "env-secrets":
    "A person must choose the existing key that opens these values; never create or rotate one by guessing.",
  "env-format":
    "Migration must use its resumable env owner; review tracked-file consent and recovery before applying.",
  "env-key":
    "Key identity, ownership, exposure or rotation needs a decision; only verified permission-only repairs can be automatic.",
  "tracked-files":
    "Untracking changes the Git index and may affect staged work; the file snapshot alone cannot safely reverse that decision.",
};
