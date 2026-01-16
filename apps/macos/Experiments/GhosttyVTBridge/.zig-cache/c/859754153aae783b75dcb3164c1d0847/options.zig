pub const @"build.build.TerminalArtifact" = enum (u1) {
    ghostty = 0,
    lib = 1,
};
pub const artifact: @"build.build.TerminalArtifact" = .lib;
pub const c_abi: bool = false;
pub const oniguruma: bool = false;
pub const simd: bool = false;
pub const slow_runtime_safety: bool = false;
pub const kitty_graphics: bool = false;
pub const tmux_control_mode: bool = false;
