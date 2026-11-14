//! Fixed read-only Doctor tool dependencies (doctor.ts and its check helpers).
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
    "dig",
    "security",
    "systemctl",
    "resolvectl",
    "scutil",
    "lsof",
    "ps",
];

pub(crate) fn affected(tool: &str, id: &str) -> bool {
    if id == tool || id == format!("{tool} (optional)") || id == format!("{tool} (sessions)") {
        return true;
    }
    match tool {
        "docker" => {
            id.starts_with("docker ")
                || id.starts_with("network:")
                || matches!(
                    id,
                    "proxy network"
                        | "proxy ports"
                        | "coredns forwarding"
                        | "grafana"
                        | "caddy hosts"
                        | "caddy local ca"
                        | "compose networks"
                        | "compose backend features"
                        | "compose env at rest"
                        | "runtime hygiene"
                        | "lifecycle hygiene"
                )
        }
        "git" => matches!(
            id,
            "env key"
                | "worktree keys"
                | "generated files"
                | "hack gitignore"
                | "worktree instances"
                | "secrets hygiene"
                | "native source size"
        ),
        // mkcert is only an optional tool-presence check above. Certificate
        // inspection uses Node parsing, Docker and security, never mkcert or openssl.
        "security" => matches!(
            id,
            "host tls trust"
                | "local ca trust"
                | "superseded caddy roots"
                | "native root trust"
                | "native ca repair"
        ),
        "brew" | "dnsmasq" => id.starts_with("dnsmasq") || id == "dnsmasq:53",
        "dig" | "scutil" | "resolvectl" => {
            id.starts_with("dns:")
                || matches!(
                    id,
                    "linux dns route" | "native host dns" | "native hack.local route"
                )
        }
        "systemctl" => id == "daemon service" || id == "linux dns route",
        "tmux" => id == "sessions mux",
        "ps" | "lsof" => id == "proxy ports" || id == "dnsmasq:53" || id == "native https owner",
        _ => false,
    }
}
