const ghostty_vt_impl = @import("ghostty-vt-impl");

pub const Terminal = ghostty_vt_impl.Terminal;
pub const ReadonlyStream = @typeInfo(@TypeOf(Terminal.vtStream)).@"fn".return_type.?;
pub const formatter = ghostty_vt_impl.formatter;
pub const RenderState = ghostty_vt_impl.RenderState;
pub const Style = ghostty_vt_impl.Style;
pub const color = ghostty_vt_impl.color;
pub const cursor = ghostty_vt_impl.cursor;
pub const page = ghostty_vt_impl.page;
