const std = @import("std");
const allocator = std.heap.page_allocator;

// Closed wire types avoid bringing a general-purpose JSON number converter into
// the bounded publication artifact. Zig's ordinary integer/string parsers also
// accept coercions (quoted numbers and byte arrays) which this protocol refuses.
const String = struct {
    bytes: []const u8,
    pub fn jsonParse(alloc: std.mem.Allocator, source: anytype, options: std.json.ParseOptions) !@This() {
        return .{ .bytes = switch (try source.nextAllocMax(alloc, options.allocate.?, options.max_value_len.?)) {
            .string, .allocated_string => |bytes| bytes,
            else => return error.UnexpectedToken,
        } };
    }
};
const Values = std.json.ArrayHashMap(String);
const Integer = struct {
    value: i64,
    pub fn jsonParse(alloc: std.mem.Allocator, source: anytype, options: std.json.ParseOptions) !@This() {
        const token = try source.nextAllocMax(alloc, .alloc_if_needed, options.max_value_len.?);
        const text = switch (token) {
            .number => |text| text,
            .allocated_number => |text| text,
            else => return error.UnexpectedToken,
        };
        defer if (token == .allocated_number) alloc.free(text);
        return .{ .value = try std.fmt.parseInt(i64, text, 10) };
    }
};
const Fresh = struct { version: Integer, expires: Integer, values: Values };

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
fn freshValues(value: Fresh, started: u64, now: u64) !std.StringArrayHashMapUnmanaged(String) {
    if (value.version.value != 1 or value.expires.value <= 0 or value.values.map.count() == 0 or value.values.map.count() > 256) return error.Payload;
    const deadline: u64 = @intCast(value.expires.value);
    if (deadline > (std.math.add(u64, started, 300) catch return error.Expired) or now >= deadline) return error.Expired;
    var entries = value.values.map.iterator();
    while (entries.next()) |entry| {
        if (!keyValid(entry.key_ptr.*) or std.mem.indexOfScalar(u8, entry.value_ptr.bytes, 0) != null) return error.Payload;
    }
    return value.values.map;
}
/// Exec the selected process in this container after applying its environment,
/// as Docker does: a name containing `/` is executed as given (relative to the
/// working directory), and a bare name is resolved through the container's PATH
/// (Docker's default PATH when none is set). Never consult a host PATH or start
/// a shell. Startup, health and exec all use this.
fn execCommand(args: []const [:0]u8, env: *const std.process.EnvMap) !void {
    if (args.len == 0 or args[0].len == 0) return error.Arguments;
    const command = args[0];
    if (std.mem.indexOfScalar(u8, command, '/') != null) {
        return std.process.execve(allocator, args, env);
    }
    const path = env.get("PATH") orelse "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    if (path.len > 8192) return error.Arguments;
    const argv = try allocator.alloc([]const u8, args.len);
    defer allocator.free(argv);
    for (args, 0..) |arg, i| argv[i] = arg;
    var entries = std.mem.splitScalar(u8, path, ':');
    var count: usize = 0;
    var denied = false;
    while (entries.next()) |entry| {
        count += 1;
        if (count > 128) return error.Arguments;
        const directory = if (entry.len == 0) "." else entry;
        if (directory.len + command.len + 2 > 4096) continue;
        const candidate = try std.fmt.allocPrint(allocator, "{s}/{s}", .{ directory, command });
        defer allocator.free(candidate);
        argv[0] = candidate;
        switch (std.process.execve(allocator, argv, env)) {
            error.FileNotFound, error.NotDir => continue,
            error.AccessDenied => {
                denied = true;
                continue;
            },
            else => |err| return err,
        }
    }
    if (denied) return error.AccessDenied;
    return error.FileNotFound;
}
fn freshExec(args: []const [:0]u8) !void {
    if (args.len < 3 or args.len > 4099) return error.Arguments;
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
    const parsed = try std.json.parseFromSlice(Fresh, allocator, input[0..used], .{ .duplicate_field_behavior = .@"error" });
    defer parsed.deinit();
    const values = try freshValues(parsed.value, started, try bootSeconds());
    var env = try std.process.getEnvMap(allocator);
    var entries = values.iterator();
    while (entries.next()) |entry| {
        if (!keyValid(entry.key_ptr.*) or std.mem.indexOfScalar(u8, entry.value_ptr.bytes, 0) != null) return error.Payload;
        try env.put(entry.key_ptr.*, entry.value_ptr.bytes);
    }
    _ = try freshValues(parsed.value, started, try bootSeconds());
    // stdin was fully consumed to EOF; the command receives no secret input bytes.
    return execCommand(args[2..], &env);
}

/// The private envelope uses only printable base64, so Docker's detach-key
/// scanner cannot interpret its contents. Nothing is sent until echo is off;
/// user input is withheld until the restored-terminal acknowledgement.
fn interactiveFreshExec(args: []const [:0]u8) !void {
    if (args.len < 3 or args.len > 4099) return error.Arguments;
    const started = try bootSeconds();
    const saved = try std.posix.tcgetattr(0);
    var raw = saved;
    raw.iflag.BRKINT = false;
    raw.iflag.ICRNL = false;
    raw.iflag.INLCR = false;
    raw.iflag.IGNCR = false;
    raw.iflag.ISTRIP = false;
    raw.iflag.IXON = false;
    raw.iflag.PARMRK = false;
    raw.oflag.OPOST = false;
    raw.lflag.ECHO = false;
    raw.lflag.ECHONL = false;
    raw.lflag.ICANON = false;
    raw.lflag.ISIG = false;
    raw.lflag.IEXTEN = false;
    raw.cflag.CSIZE = .CS8;
    raw.cflag.PARENB = false;
    raw.cc[@intFromEnum(std.posix.V.MIN)] = 1;
    raw.cc[@intFromEnum(std.posix.V.TIME)] = 0;
    try std.posix.tcsetattr(0, .NOW, raw);
    // On failure leave echo disabled, including for bytes still in flight.
    // The guest launcher targets Linux; Zig has no portable tcflush wrapper.
    errdefer _ = std.os.linux.ioctl(0, std.os.linux.T.CFLSH, 0); // TCIFLUSH
    var hello: [64]u8 = undefined;
    const marker = try std.fmt.bufPrint(&hello, "HKEE2 {d}\n", .{started});
    if (try std.posix.write(1, marker) != marker.len) return error.Transport;
    var env = try interactiveEnvelope(started);
    defer env.deinit();
    try std.posix.tcsetattr(0, .DRAIN, saved);
    const ack = "HKEE2 OK\n";
    if (try std.posix.write(1, ack) != ack.len) return error.Transport;
    return execCommand(args[2..], &env);
}

fn privateRead(destination: []u8, started: u64) !void {
    var used: usize = 0;
    while (used < destination.len) {
        const now = try bootSeconds();
        if (now >= started + 5) return error.Expired;
        var fds = [_]std.posix.pollfd{.{ .fd = 0, .events = std.posix.POLL.IN, .revents = 0 }};
        if (try std.posix.poll(&fds, @intCast((started + 5 - now) * 1000)) == 0) return error.Expired;
        const n = try std.posix.read(0, destination[used..]);
        if (n == 0) return error.Transport;
        used += n;
    }
}

fn interactiveEnvelope(started: u64) !std.process.EnvMap {
    var header: [32]u8 = undefined;
    defer std.crypto.secureZero(u8, &header);
    var used: usize = 0;
    while (true) {
        if (used == header.len) return error.Payload;
        try privateRead(header[used..][0..1], started);
        used += 1;
        if (header[used - 1] == '\n') break;
    }
    if (!std.mem.startsWith(u8, header[0..used], "HKEE2 ")) return error.Payload;
    const digits = header[6 .. used - 1];
    if (digits.len == 0 or digits[0] == '0') return error.Payload;
    for (digits) |c| if (!std.ascii.isDigit(c)) return error.Payload;
    const length = try std.fmt.parseInt(usize, digits, 10);
    const encoded = try allocator.alloc(u8, 87384);
    defer {
        std.crypto.secureZero(u8, encoded);
        allocator.free(encoded);
    }
    if (length == 0 or length > encoded.len) return error.Payload;
    try privateRead(encoded[0..length], started);
    const decoder = std.base64.standard.Decoder;
    const decoded_length = try decoder.calcSizeForSlice(encoded[0..length]);
    if (decoded_length == 0 or decoded_length > 65536) return error.Payload;
    const decoded = try allocator.alloc(u8, 65536);
    defer {
        std.crypto.secureZero(u8, decoded);
        allocator.free(decoded);
    }
    try decoder.decode(decoded[0..decoded_length], encoded[0..length]);
    // JSON may allocate decoded escape sequences. Keep all parse storage in a
    // bounded arena which is wiped before the acknowledgement, too.
    const storage = try allocator.alloc(u8, 512 * 1024);
    defer {
        std.crypto.secureZero(u8, storage);
        allocator.free(storage);
    }
    var fixed = std.heap.FixedBufferAllocator.init(storage);
    const parsed = try std.json.parseFromSlice(Fresh, fixed.allocator(), decoded[0..decoded_length], .{ .duplicate_field_behavior = .@"error" });
    defer parsed.deinit();
    const values = try freshValues(parsed.value, started, try bootSeconds());
    var env = try std.process.getEnvMap(allocator);
    errdefer env.deinit();
    var entries = values.iterator();
    while (entries.next()) |entry| try env.put(entry.key_ptr.*, entry.value_ptr.bytes);
    // The host is still gating keystrokes. Pending bytes mean a bad envelope,
    // not command input; never restore echo over them.
    var fds = [_]std.posix.pollfd{.{ .fd = 0, .events = std.posix.POLL.IN, .revents = 0 }};
    if (try std.posix.poll(&fds, 0) != 0) return error.Payload;
    _ = try freshValues(parsed.value, started, try bootSeconds());
    return env;
}
fn run() !void {
    try std.posix.setrlimit(.CORE, .{ .cur = 0, .max = 0 });
    const raw = try std.process.argsAlloc(allocator);
    if (raw.len > 1 and std.mem.eql(u8, raw[1], "--exec-environment-stdin-v1")) return freshExec(raw);
    if (raw.len > 1 and std.mem.eql(u8, raw[1], "--exec-environment-tty-v2")) return interactiveFreshExec(raw);
    const health = raw.len > 1 and std.mem.eql(u8, raw[1], "--health");
    const mounted_exec = raw.len > 1 and std.mem.eql(u8, raw[1], "--exec-mounted-v1");
    if (health) {
        const null_fd = try std.posix.open("/dev/null", .{ .ACCMODE = .RDWR, .CLOEXEC = true }, 0);
        defer if (null_fd > 2) std.posix.close(null_fd);
        try std.posix.dup2(null_fd, 0);
        try std.posix.dup2(null_fd, 1);
        try std.posix.dup2(null_fd, 2);
    }
    const args = if (health or mounted_exec) raw[1..] else raw;
    if (args.len < 4 or args.len > 4100 or args[3].len == 0) return error.Arguments;
    const payload = try privateFile(args[1], 32768);
    const expiry = try privateFile(args[2], 32);
    const deadline = try std.fmt.parseInt(u64, expiry, 10);
    const parsed = try std.json.parseFromSlice(Values, allocator, payload, .{ .duplicate_field_behavior = .@"error" });
    if (parsed.value.map.count() == 0 or parsed.value.map.count() > 256) return error.Payload;
    var env = try std.process.getEnvMap(allocator);
    var entries = parsed.value.map.iterator();
    while (entries.next()) |entry| {
        if (!keyValid(entry.key_ptr.*) or std.mem.indexOfScalar(u8, entry.value_ptr.bytes, 0) != null) return error.Payload;
        try env.put(entry.key_ptr.*, entry.value_ptr.bytes);
    }
    const now = try std.posix.clock_gettime(.BOOTTIME);
    if (now.sec < 0 or @as(u64, @intCast(now.sec)) >= deadline) return error.Expired;
    // Successful exec replaces this process: no resident wrapper and no signal forwarding shim.
    return execCommand(args[3..], &env);
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
        const parsed = std.json.parseFromSlice(Fresh, std.testing.allocator, fixture, .{ .duplicate_field_behavior = .@"error" }) catch |err| {
            if (i == 0) return err;
            continue;
        };
        defer parsed.deinit();
        if (i == 0) {
            _ = try freshValues(parsed.value, 100, 101);
        } else {
            if (freshValues(parsed.value, 100, 101)) |_| return error.ExpectedRefusal else |_| {}
        }
    }
}

test "wire schema refuses numeric coercions duplicate fields and non-string values" {
    const bad_numbers = [_][]const u8{ "\"1\"", "1.0", "1e0", "true", "null", "9223372036854775808", "-9223372036854775809" };
    for (bad_numbers) |number| {
        for ([_][]const u8{ "version", "expires" }) |field| {
            const other = if (std.mem.eql(u8, field, "version")) "\"expires\":130" else "\"version\":1";
            const input = try std.fmt.allocPrint(std.testing.allocator, "{{\"{s}\":{s},{s},\"values\":{{\"TOKEN\":\"synthetic\"}}}}", .{ field, number, other });
            defer std.testing.allocator.free(input);
            if (std.json.parseFromSlice(Fresh, std.testing.allocator, input, .{ .duplicate_field_behavior = .@"error" })) |parsed| {
                parsed.deinit();
                return error.ExpectedRefusal;
            } else |_| {}
        }
    }
    for ([_][]const u8{
        "{\"TOKEN\":[97]}",                           "{\"TOKEN\":{}}", "{\"TOKEN\":null}",
        "{\"TOKEN\":true}",                           "{\"TOKEN\":1}",  "{\"TOKEN\":1.0}",
        "{\"TOKEN\":\"first\",\"TOKEN\":\"second\"}", "[]",
    }) |input| {
        if (std.json.parseFromSlice(Values, std.testing.allocator, input, .{ .duplicate_field_behavior = .@"error" })) |parsed| {
            parsed.deinit();
            return error.ExpectedRefusal;
        } else |_| {}
    }
    for ([_][]const u8{
        "{\"version\":1,\"version\":1,\"expires\":130,\"values\":{\"TOKEN\":\"synthetic\"}}",
        "{\"version\":1,\"expires\":130,\"values\":{\"TOKEN\":\"synthetic\"},\"extra\":0}",
        "{\"version\":1,\"values\":{\"TOKEN\":\"synthetic\"}}",
    }) |input| {
        if (std.json.parseFromSlice(Fresh, std.testing.allocator, input, .{ .duplicate_field_behavior = .@"error" })) |parsed| {
            parsed.deinit();
            return error.ExpectedRefusal;
        } else |_| {}
    }
}

test "mounted and fresh schemas preserve empty escaped and unicode strings" {
    const values = "{\"EMPTY\":\"\",\"TOKEN\":\"synthetic\\n\\u0010\\u0011\\u00e9\"}";
    const expected = "synthetic\n\x10\x11\xc3\xa9";
    const mounted = try std.json.parseFromSlice(Values, std.testing.allocator, values, .{ .duplicate_field_behavior = .@"error" });
    defer mounted.deinit();
    try std.testing.expectEqualStrings("", mounted.value.map.get("EMPTY").?.bytes);
    try std.testing.expectEqualStrings(expected, mounted.value.map.get("TOKEN").?.bytes);
    const fresh = try std.json.parseFromSlice(Fresh, std.testing.allocator, "{\"version\":1,\"expires\":130,\"values\":" ++ values ++ "}", .{ .duplicate_field_behavior = .@"error" });
    defer fresh.deinit();
    const checked = try freshValues(fresh.value, 100, 101);
    try std.testing.expectEqualStrings("", checked.get("EMPTY").?.bytes);
    try std.testing.expectEqualStrings(expected, checked.get("TOKEN").?.bytes);
}
