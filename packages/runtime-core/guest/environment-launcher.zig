const std = @import("std");
const allocator = std.heap.page_allocator;

fn privateFile(path: []const u8, max: usize) ![]u8 {
    const fd = try std.posix.open(path, .{ .ACCMODE = .RDONLY, .NOFOLLOW = true, .CLOEXEC = true }, 0);
    const file = std.fs.File{ .handle = fd };
    defer file.close();
    const info = try std.posix.fstat(fd);
    if (!std.posix.S.ISREG(info.mode) or info.mode & 0o777 != 0o400 or
        info.uid != std.posix.geteuid() or info.gid != std.os.linux.getegid() or info.nlink != 1 or info.size < 1 or info.size > max)
        return error.UnsafeFile;
    return file.readToEndAlloc(allocator, max);
}
fn keyValid(key: []const u8) bool {
    if (key.len == 0 or !(std.ascii.isAlphabetic(key[0]) or key[0] == '_')) return false;
    for (key) |c| if (!(std.ascii.isAlphanumeric(c) or c == '_')) return false;
    return true;
}
fn run() !void {
    try std.posix.setrlimit(.CORE, .{ .cur = 0, .max = 0 });
    const args = try std.process.argsAlloc(allocator);
    if (args.len < 4 or args.len > 4100 or !std.fs.path.isAbsolute(args[3])) return error.Arguments;
    const payload = try privateFile(args[1], 8192);
    const expiry = try privateFile(args[2], 32);
    const deadline = try std.fmt.parseInt(u64, expiry, 10);
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, payload, .{ .duplicate_field_behavior = .@"error" });
    if (parsed.value != .object or parsed.value.object.count() == 0 or parsed.value.object.count() > 64) return error.Payload;
    var env = try std.process.getEnvMap(allocator);
    var entries = parsed.value.object.iterator();
    while (entries.next()) |entry| {
        if (!keyValid(entry.key_ptr.*) or entry.value_ptr.* != .string or std.mem.indexOfScalar(u8, entry.value_ptr.string, 0) != null) return error.Payload;
        try env.put(entry.key_ptr.*, entry.value_ptr.string);
    }
    const now = try std.posix.clock_gettime(.BOOTTIME);
    if (now.sec < 0 or @as(u64, @intCast(now.sec)) >= deadline) return error.Expired;
    // Successful exec replaces this process: no resident wrapper and no signal forwarding shim.
    return std.process.execve(allocator, args[3..], &env);
}
pub fn main() void {
    run() catch {
        // Never print parsed values, paths, argv, or library error diagnostics.
        std.posix.exit(125);
    };
}
