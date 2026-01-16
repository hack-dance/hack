const std = @import("std");

const UnicodeTables = struct {
    props_output: std.Build.LazyPath,
    symbols_output: std.Build.LazyPath,

    pub fn init(
        b: *std.Build,
        ghostty_path: []const u8,
        uucode_dep: *std.Build.Dependency,
    ) !UnicodeTables {
        const props_source = b.pathJoin(&.{ ghostty_path, "src", "unicode", "props_uucode.zig" });
        const symbols_source = b.pathJoin(&.{ ghostty_path, "src", "unicode", "symbols_uucode.zig" });

        const props_exe = b.addExecutable(.{
            .name = "props-unigen",
            .root_module = b.createModule(.{
                .root_source_file = .{ .cwd_relative = props_source },
                .target = b.graph.host,
                .strip = false,
                .omit_frame_pointer = false,
                .unwind_tables = .sync,
            }),
            .use_llvm = true,
        });

        const symbols_exe = b.addExecutable(.{
            .name = "symbols-unigen",
            .root_module = b.createModule(.{
                .root_source_file = .{ .cwd_relative = symbols_source },
                .target = b.graph.host,
                .strip = false,
                .omit_frame_pointer = false,
                .unwind_tables = .sync,
            }),
            .use_llvm = true,
        });

        const uucode_module = uucode_dep.module("uucode");
        props_exe.root_module.addImport("uucode", uucode_module);
        symbols_exe.root_module.addImport("uucode", uucode_module);

        const props_run = b.addRunArtifact(props_exe);
        const symbols_run = b.addRunArtifact(symbols_exe);

        const wf = b.addWriteFiles();
        const props_output = wf.addCopyFile(props_run.captureStdOut(), "props.zig");
        const symbols_output = wf.addCopyFile(symbols_run.captureStdOut(), "symbols.zig");

        return .{
            .props_output = props_output,
            .symbols_output = symbols_output,
        };
    }

    pub fn addModuleImport(self: *const UnicodeTables, module: *std.Build.Module) void {
        module.addAnonymousImport("unicode_tables", .{
            .root_source_file = self.props_output,
        });
        module.addAnonymousImport("symbols_tables", .{
            .root_source_file = self.symbols_output,
        });
    }
};

pub fn build(b: *std.Build) !void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const ghostty_path = b.option(
        []const u8,
        "ghostty",
        "Path to the ghostty repo (expected to contain src/lib_vt.zig)",
    ) orelse "../vendor/ghostty";

    const ghostty_vt_source = b.pathJoin(&.{ ghostty_path, "src", "lib_vt.zig" });
    const ghostty_vt_impl = b.createModule(.{
        .root_source_file = .{ .cwd_relative = ghostty_vt_source },
        .target = target,
        .optimize = optimize,
    });

    const uucode_config_path = b.pathJoin(&.{ ghostty_path, "src", "build", "uucode_config.zig" });
    const uucode = b.dependency("uucode", .{
        .build_config_path = std.Build.LazyPath{ .cwd_relative = uucode_config_path },
    });
    const unicode_tables = try UnicodeTables.init(b, ghostty_path, uucode);
    unicode_tables.addModuleImport(ghostty_vt_impl);

    const TerminalArtifact = enum {
        ghostty,
        lib,
    };

    const opts = b.addOptions();
    opts.addOption(TerminalArtifact, "artifact", .lib);
    opts.addOption(bool, "c_abi", false);
    opts.addOption(bool, "oniguruma", false);
    opts.addOption(bool, "simd", false);
    opts.addOption(bool, "slow_runtime_safety", false);
    opts.addOption(bool, "kitty_graphics", false);
    opts.addOption(bool, "tmux_control_mode", false);

    ghostty_vt_impl.addOptions("terminal_options", opts);

    const ghostty_vt = b.createModule(.{
        .root_source_file = b.path("src/ghostty_vt_wrapper.zig"),
        .imports = &.{.{ .name = "ghostty-vt-impl", .module = ghostty_vt_impl }},
        .target = target,
        .optimize = optimize,
    });

    const bridge_module = b.createModule(.{
        .root_source_file = b.path("src/bridge.zig"),
        .target = target,
        .optimize = optimize,
    });
    bridge_module.link_libc = true;

    const lib = b.addLibrary(.{
        .name = "hack_ghostty_vt",
        .root_module = bridge_module,
        .linkage = .dynamic,
    });
    lib.root_module.addImport("ghostty-vt", ghostty_vt);
    b.installArtifact(lib);
}
