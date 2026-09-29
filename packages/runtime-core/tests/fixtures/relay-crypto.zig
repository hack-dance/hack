//! Test-only interop bridge: independent pinned Zig standard-library HMAC.
const std = @import("std");
export fn fixture_hmac(out: *[32]u8, key: *const [32]u8, input: [*]const u8, length: usize) void {
    std.crypto.auth.hmac.sha2.HmacSha256.create(out, input[0..length], key);
}
