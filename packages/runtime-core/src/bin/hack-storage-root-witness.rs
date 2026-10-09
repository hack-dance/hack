//! Guest-only artifact; host startup never runs or discovers this executable.
fn main() -> std::process::ExitCode {
    hack_runtime_core::provider::storage_root_witness_tool()
}
