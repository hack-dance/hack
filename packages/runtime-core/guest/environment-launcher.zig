const std = @import("std");
const allocator = std.heap.page_allocator;

fn privateFile(path: []const u8, max: usize) ![]u8 {
    const fd = try std.posix.open(path, .{ .ACCMODE = .RDONLY, .NOFOLLOW = true, .CLOEXEC = true }, 0);
    const file = std.fs.File{ .handle = fd };
    defer file.close();
    const info = try std.posix.fstat(fd);
    // Owner-only mode0400 requires the exact UID. Docker may resolve a UID-only
    // image User to another primary group; file GID grants no access here.
    if (!std.posix.S.ISREG(info.mode) or info.mode & 0o777 != 0o400 or
        info.uid != std.posix.geteuid() or info.nlink != 1 or info.size < 1 or info.size > max)
        return error.UnsafeFile;
    return file.readToEndAlloc(allocator, max);
}
fn keyValid(key: []const u8) bool {
    if (key.len == 0 or !(std.ascii.isAlphabetic(key[0]) or key[0] == '_')) return false;
    for (key) |c| if (!(std.ascii.isAlphanumeric(c) or c == '_')) return false;
    return true;
}
fn bootSeconds() !u64 {
    const now = try std.posix.clock_gettime(.BOOTTIME);
    if (now.sec < 0) return error.Expired;
    return @intCast(now.sec);
}
fn freshValues(value: std.json.Value, started: u64, now: u64) !std.json.ObjectMap {
    if (value != .object or value.object.count() != 3) return error.Payload;
    const version = value.object.get("version") orelse return error.Payload;
    const expires = value.object.get("expires") orelse return error.Payload;
    const values = value.object.get("values") orelse return error.Payload;
    if (version != .integer or version.integer != 1 or expires != .integer or expires.integer <= 0 or values != .object or values.object.count() == 0 or values.object.count() > 256) return error.Payload;
    const deadline: u64 = @intCast(expires.integer);
    if (deadline > (std.math.add(u64, started, 300) catch return error.Expired) or now >= deadline) return error.Expired;
    var entries = values.object.iterator();
    while (entries.next()) |entry| {
        if (!keyValid(entry.key_ptr.*) or entry.value_ptr.* != .string or std.mem.indexOfScalar(u8, entry.value_ptr.string, 0) != null) return error.Payload;
    }
    return values.object;
}
fn freshExec(args: []const [:0]u8) !void {
    if (args.len < 3 or args.len > 4099 or !std.fs.path.isAbsolute(args[2])) return error.Arguments;
    const started = try bootSeconds();
    var hello: [64]u8 = undefined;
    const text = try std.fmt.bufPrint(&hello, "HKEE1 {d}\n", .{started});
    if (try std.posix.write(1, text) != text.len) return error.Transport;
    var input: [65537]u8 = undefined;
    defer std.crypto.secureZero(u8, &input);
    var used: usize = 0;
    while (true) {
        const now = try bootSeconds();
        if (now >= started + 5) return error.Expired;
        var fds = [_]std.posix.pollfd{.{ .fd = 0, .events = std.posix.POLL.IN, .revents = 0 }};
        if (try std.posix.poll(&fds, @intCast((started + 5 - now) * 1000)) == 0) return error.Expired;
        const n = try std.posix.read(0, input[used..]);
        if (n == 0) break;
        used += n;
        if (used > 65536) return error.Payload;
    }
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, input[0..used], .{ .duplicate_field_behavior = .@"error" });
    defer parsed.deinit();
    const values = try freshValues(parsed.value, started, try bootSeconds());
    var env = try std.process.getEnvMap(allocator);
    var entries = values.iterator();
    while (entries.next()) |entry| {
        if (!keyValid(entry.key_ptr.*) or entry.value_ptr.* != .string or std.mem.indexOfScalar(u8, entry.value_ptr.string, 0) != null) return error.Payload;
        try env.put(entry.key_ptr.*, entry.value_ptr.string);
    }
    _ = try freshValues(parsed.value, started, try bootSeconds());
    // stdin was fully consumed to EOF; the command receives no secret input bytes.
    return std.process.execve(allocator, args[2..], &env);
}
fn run() !void {
    try std.posix.setrlimit(.CORE, .{ .cur = 0, .max = 0 });
    const raw = try std.process.argsAlloc(allocator);
    if (raw.len > 1 and std.mem.eql(u8, raw[1], "--exec-environment-stdin-v1")) return freshExec(raw);
    const health = raw.len > 1 and std.mem.eql(u8, raw[1], "--health");
    if (health) {
        const null_fd = try std.posix.open("/dev/null", .{ .ACCMODE = .RDWR, .CLOEXEC = true }, 0);
        defer if (null_fd > 2) std.posix.close(null_fd);
        try std.posix.dup2(null_fd, 0);
        try std.posix.dup2(null_fd, 1);
        try std.posix.dup2(null_fd, 2);
    }
    const args = if (health) raw[1..] else raw;
    if (args.len < 4 or args.len > 4100 or !std.fs.path.isAbsolute(args[3])) return error.Arguments;
    const payload = try privateFile(args[1], 32768);
    const expiry = try privateFile(args[2], 32);
    const deadline = try std.fmt.parseInt(u64, expiry, 10);
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, payload, .{ .duplicate_field_behavior = .@"error" });
    if (parsed.value != .object or parsed.value.object.count() == 0 or parsed.value.object.count() > 256) return error.Payload;
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

test "fresh envelope refuses expired invalid and extra fields" {
    const fixtures = [_][]const u8{
        "{\"version\":1,\"expires\":130,\"values\":{\"TOKEN\":\"synthetic\"}}",
        "{\"version\":1,\"expires\":100,\"values\":{\"TOKEN\":\"synthetic\"}}",
        "{\"version\":1,\"expires\":401,\"values\":{\"TOKEN\":\"synthetic\"}}",
        "{\"version\":1,\"expires\":130,\"values\":{\"INVALID-KEY\":\"synthetic\"}}",
        "{\"version\":1,\"expires\":130,\"values\":{\"TOKEN\":42}}",
        "{\"version\":1,\"expires\":130,\"values\":{},\"extra\":true}",
    };
    for (fixtures, 0..) |fixture, i| {
        const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, fixture, .{ .duplicate_field_behavior = .@"error" });
        defer parsed.deinit();
        if (i == 0) {
            _ = try freshValues(parsed.value, 100, 101);
        } else {
            if (freshValues(parsed.value, 100, 101)) |_| return error.ExpectedRefusal else |_| {}
        }
    }
}
