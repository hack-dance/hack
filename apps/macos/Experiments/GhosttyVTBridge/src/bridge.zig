const std = @import("std");
const ghostty_vt = @import("ghostty-vt");

const TerminalHandle = struct {
    alloc: std.mem.Allocator,
    terminal: ghostty_vt.Terminal,
    stream: ghostty_vt.ReadonlyStream,
    render_state: ghostty_vt.RenderState,
};

const RenderColor = extern struct {
    r: u8,
    g: u8,
    b: u8,
    a: u8,
};

const RenderCell = extern struct {
    codepoint: u32,
    fg: RenderColor,
    bg: RenderColor,
    wide: u8,
    flags: u16,
    _pad: u8 = 0,
};

const RenderSnapshot = extern struct {
    rows: u16,
    cols: u16,
    cursor_x: u16,
    cursor_y: u16,
    cursor_visible: u8,
    cursor_style: u8,
    cursor_wide_tail: u8,
    _pad0: u8 = 0,
    default_fg: RenderColor,
    default_bg: RenderColor,
    cursor_color: RenderColor,
    cell_count: usize,
    cells: [*]RenderCell,
};

fn toRenderColor(rgb: ghostty_vt.color.RGB) RenderColor {
    return .{ .r = rgb.r, .g = rgb.g, .b = rgb.b, .a = 255 };
}

fn toCellCount(value: u32) ?u16 {
    if (value == 0) return null;
    return std.math.cast(u16, value);
}

export fn hack_ghostty_vt_create(cols: u32, rows: u32) ?*TerminalHandle {
    const cols_u16 = toCellCount(cols) orelse return null;
    const rows_u16 = toCellCount(rows) orelse return null;
    const alloc = std.heap.c_allocator;
    var handle = alloc.create(TerminalHandle) catch return null;
    handle.alloc = alloc;
    handle.terminal = ghostty_vt.Terminal.init(alloc, .{ .cols = cols_u16, .rows = rows_u16 }) catch {
        alloc.destroy(handle);
        return null;
    };
    handle.stream = handle.terminal.vtStream();
    handle.render_state = .empty;
    return handle;
}

export fn hack_ghostty_vt_destroy(handle: ?*TerminalHandle) void {
    if (handle == null) return;
    handle.?.stream.deinit();
    handle.?.render_state.deinit(handle.?.alloc);
    handle.?.terminal.deinit(handle.?.alloc);
    handle.?.alloc.destroy(handle.?);
}

export fn hack_ghostty_vt_resize(handle: ?*TerminalHandle, cols: u32, rows: u32) void {
    if (handle == null) return;
    const cols_u16 = toCellCount(cols) orelse return;
    const rows_u16 = toCellCount(rows) orelse return;
    handle.?.terminal.resize(handle.?.alloc, cols_u16, rows_u16) catch {};
}

export fn hack_ghostty_vt_feed(handle: ?*TerminalHandle, bytes: [*]const u8, len: usize) void {
    if (handle == null) return;
    if (len == 0) return;
    _ = handle.?.stream.nextSlice(bytes[0..len]) catch {};
}

export fn hack_ghostty_vt_plain_string(handle: ?*TerminalHandle, out_len: ?*usize) ?[*]u8 {
    if (handle == null) return null;
    const str = handle.?.terminal.plainString(handle.?.alloc) catch return null;
    if (out_len) |ptr| {
        ptr.* = str.len;
    }
    return @constCast(str.ptr);
}

export fn hack_ghostty_vt_html_string(handle: ?*TerminalHandle, out_len: ?*usize) ?[*]u8 {
    if (handle == null) return null;

    var builder: std.Io.Writer.Allocating = .init(handle.?.alloc);
    errdefer builder.deinit();

    const opts = ghostty_vt.formatter.Options{
        .emit = .html,
        .unwrap = false,
        .trim = false,
        .palette = &handle.?.terminal.colors.palette.current,
    };

    var formatter: ghostty_vt.formatter.TerminalFormatter = .init(&handle.?.terminal, opts);
    formatter.extra = .none;

    formatter.format(&builder.writer) catch return null;
    const slice = builder.toOwnedSlice() catch return null;
    if (out_len) |ptr| {
        ptr.* = slice.len;
    }
    return @constCast(slice.ptr);
}

export fn hack_ghostty_vt_free_string(ptr: ?[*]u8, len: usize) void {
    if (ptr == null or len == 0) return;
    std.heap.c_allocator.free(ptr.?[0..len]);
}

export fn hack_ghostty_vt_render_snapshot(handle: ?*TerminalHandle) ?*RenderSnapshot {
    if (handle == null) return null;
    const alloc = handle.?.alloc;
    handle.?.render_state.update(alloc, &handle.?.terminal) catch return null;
    const state = &handle.?.render_state;
    const rows: usize = @intCast(state.rows);
    const cols: usize = @intCast(state.cols);
    if (rows == 0 or cols == 0) return null;
    const cell_count = rows * cols;

    const cells = alloc.alloc(RenderCell, cell_count) catch return null;
    errdefer alloc.free(cells);
    const snapshot = alloc.create(RenderSnapshot) catch return null;
    errdefer alloc.destroy(snapshot);

    const default_fg = toRenderColor(state.colors.foreground);
    const default_bg = toRenderColor(state.colors.background);
    const cursor_color = if (state.colors.cursor) |rgb| toRenderColor(rgb) else default_fg;

    snapshot.* = .{
        .rows = @intCast(state.rows),
        .cols = @intCast(state.cols),
        .cursor_x = 0,
        .cursor_y = 0,
        .cursor_visible = 0,
        .cursor_style = @intFromEnum(state.cursor.visual_style),
        .cursor_wide_tail = 0,
        .default_fg = default_fg,
        .default_bg = default_bg,
        .cursor_color = cursor_color,
        .cell_count = cell_count,
        .cells = cells.ptr,
    };

    if (state.cursor.viewport) |viewport| {
        if (state.cursor.visible) {
            snapshot.cursor_visible = 1;
            snapshot.cursor_x = @intCast(viewport.x);
            snapshot.cursor_y = @intCast(viewport.y);
            snapshot.cursor_wide_tail = if (viewport.wide_tail) 1 else 0;
        }
    }

    const row_cells = state.row_data.items(.cells);
    for (0..rows) |row| {
        const cell_list = row_cells[row];
        const raws = cell_list.items(.raw);
        const styles = cell_list.items(.style);
        const graphemes = cell_list.items(.grapheme);
        for (0..cols) |col| {
            const raw = raws[col];
            const style = if (raw.style_id == 0) ghostty_vt.Style{} else styles[col];
            var codepoint: u32 = 0;
            switch (raw.content_tag) {
                .codepoint => codepoint = raw.content.codepoint,
                .codepoint_grapheme => {
                    const cluster = graphemes[col];
                    if (cluster.len > 0) {
                        codepoint = cluster[0];
                    } else {
                        codepoint = raw.content.codepoint;
                    }
                },
                else => codepoint = 0,
            }

            var fg = toRenderColor(style.fg(.{
                .default = state.colors.foreground,
                .palette = &state.colors.palette,
            }));
            var bg = if (style.bg(&raw, &state.colors.palette)) |rgb|
                toRenderColor(rgb)
            else
                default_bg;

            if (style.flags.inverse) {
                const tmp = fg;
                fg = bg;
                bg = tmp;
            }
            if (style.flags.invisible) {
                fg = bg;
            }

            var flags: u16 = 0;
            if (style.flags.bold) flags |= 1 << 0;
            if (style.flags.italic) flags |= 1 << 1;
            if (style.flags.underline != .none) flags |= 1 << 2;
            if (style.flags.inverse) flags |= 1 << 3;
            if (style.flags.faint) flags |= 1 << 4;
            if (style.flags.strikethrough) flags |= 1 << 5;
            if (style.flags.blink) flags |= 1 << 6;
            if (style.flags.invisible) flags |= 1 << 7;

            cells[row * cols + col] = .{
                .codepoint = codepoint,
                .fg = fg,
                .bg = bg,
                .wide = @intFromEnum(raw.wide),
                .flags = flags,
                ._pad = 0,
            };
        }
    }

    return snapshot;
}

export fn hack_ghostty_vt_render_snapshot_free(snapshot: ?*RenderSnapshot) void {
    if (snapshot == null) return;
    const alloc = std.heap.c_allocator;
    alloc.free(snapshot.?.cells[0..snapshot.?.cell_count]);
    alloc.destroy(snapshot.?);
}
