//! Fixed read-only Doctor tool dependencies (doctor.ts and its check helpers).
//! Audit and exclusions: apps/desktop/DOCTOR_TOOLS.md. Only read-path dependencies belong here.
//! This is coverage attribution, not an executable or plugin discovery framework.

pub(crate) const NAMES: &[&str] = &[
    "bun",
    "docker",
    "brew",
    "dnsmasq",
    "mkcert",
    "gum",
    "fzf",
    "tmux",
    "mutagen",
    "go",
    "caddy",
    "asdf",
    "git",
    "security",
    "systemctl",
    "resolvectl",
    "ip",
    "loginctl",
    "zellij",
    "ss",
    "lsof",
    "ps",
];

pub(crate) fn affected(tool: &str, id: &str) -> bool {
    if id == tool || id == format!("{tool} (optional)") || id == format!("{tool} (sessions)") {
        return true;
    }
    match tool {
        "docker" => {
            matches!(id, "docker compose" | "docker daemon")
                || id.starts_with("network:")
                || id.starts_with("dnsmasq.conf:")
                || (id.starts_with("dns:") && !matches!(id, "dns:hack" | "dns:hack.gy"))
                || matches!(
                    id,
                    "proxy network"
                        | "proxy ports"
                        | "coredns forwarding"
                        | "caddy hosts"
                        | "caddy local ca"
                        | "runtime hygiene"
                        | "lifecycle hygiene"
                        | "worktree instances"
                )
        }
        "git" => matches!(
            id,
            "env key"
                | "worktree keys"
                | "generated files"
                | "hack gitignore"
                | "secrets hygiene"
                | "secret integrity"
                | "env materialization"
        ),
        // mkcert is only an optional tool-presence check above. Certificate
        // inspection uses Node parsing, Docker and security, never mkcert or openssl.
        "security" => matches!(
            id,
            "host tls trust"
                | "superseded caddy roots"
                | "native root trust"
                | "native https owner"
                | "native https route"
        ),
        "brew" => id.starts_with("dnsmasq.conf:") || id == "native hack.local route",
        "systemctl" => matches!(id, "daemon service" | "linux dns route"),
        "loginctl" => id == "daemon service",
        "ip" | "resolvectl" => id == "linux dns route",
        "tmux" => matches!(
            id,
            "sessions mux" | "lifecycle hygiene" | "runtime hygiene" | "worktree instances"
        ),
        "zellij" => matches!(
            id,
            "lifecycle hygiene" | "runtime hygiene" | "worktree instances"
        ),
        "ps" => id == "lifecycle hygiene",
        // lsof/ss only enrich an already-failed proxy diagnostic. Their absence
        // is covered by the tool card, never erases the verified port failure.
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_only_checks_never_inherit_path_tool_dependencies() {
        for tool in NAMES {
            for id in [
                "project",
                "compose networks",
                "compose backend features",
                "compose env at rest",
                "native source size",
                "resolver:hack.local",
                "dnsmasq:53",
                "grafana",
                "env mode",
                "env overlay warnings",
                "global files",
            ] {
                assert!(
                    !affected(tool, id),
                    "{tool} cannot invalidate file-only/internal observation {id}"
                );
            }
        }
        for tool in ["dig", "scutil", "openssl"] {
            assert!(!NAMES.contains(&tool));
        }
        for tool in [
            "mkcert", "caddy", "dnsmasq", "go", "asdf", "bun", "gum", "fzf", "mutagen",
        ] {
            assert!(affected(tool, tool));
            for id in ["caddy local ca", "host tls trust", "native root trust"] {
                assert!(
                    !affected(tool, id),
                    "optional/presence-only {tool} cannot invalidate {id}"
                );
            }
        }
    }
}
