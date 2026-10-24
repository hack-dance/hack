//! Label namespaces that Hack writes as resource ownership evidence.

/// Container, network and volume label namespaces that Hack writes to prove
/// which resources it owns. This mirrors `HACK_OWNERSHIP_LABEL_NAMESPACES` in
/// `src/lib/hack-ownership-labels.ts`, the source of truth;
/// `tests/hack-ownership-labels.test.ts` fails when the two lists differ.
///
/// A project must not declare a label in these namespaces, because the native
/// runtime and native-config Compose trust them as ownership evidence. The
/// TypeScript classifier rejects such labels first; the candidate's own label
/// review rejects them again so a bypassed classifier cannot pass one through.
pub(super) const HACK_OWNERSHIP_LABEL_NAMESPACES: [&str; 4] = [
    "io.hack-local.",
    "io.hack.native-config.",
    "io.hack.native-file.",
    "io.hack.storage-witness.",
];

/// Whether `key` is inside a Hack ownership namespace or is a namespace root
/// without its trailing dot (for example `io.hack-local`).
pub(super) fn is_hack_ownership_label(key: &str) -> bool {
    HACK_OWNERSHIP_LABEL_NAMESPACES
        .iter()
        .any(|namespace| key.starts_with(namespace) || namespace.strip_suffix('.') == Some(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ownership_namespaces_and_roots_are_hack_ownership_labels() {
        for key in [
            "io.hack-local.owner",
            "io.hack-local",
            "io.hack.native-config.owner",
            "io.hack.native-config",
            "io.hack.native-file.token",
            "io.hack.native-file",
            "io.hack.storage-witness.carrier",
            "io.hack.storage-witness",
        ] {
            assert!(is_hack_ownership_label(key), "{key}");
        }
    }

    #[test]
    fn near_miss_keys_are_not_hack_ownership_labels() {
        for key in [
            "io.hack",
            "io.hack.",
            "io.hacker.owner",
            "io.hack-localx.owner",
            "io.hack.native-configx",
            "io.hack.storage",
            "io.hack.custom",
            "example.io.hack-local.owner",
            "IO.HACK-LOCAL.OWNER",
        ] {
            assert!(!is_hack_ownership_label(key), "{key}");
        }
    }
}
