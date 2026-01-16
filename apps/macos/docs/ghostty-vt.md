# Ghostty VT integration notes

This document summarizes the Ghostty VT concepts we rely on and what it would
take to move from the current HTML snapshot renderer to Ghostty's native
renderer.

## Control sequences (VT concepts)

Ghostty’s VT core interprets control sequences written to a PTY. The key families:

- **C0 control characters** (`0x00`–`0x20`): single‑byte controls like `BEL`, `BS`,
  `TAB`, `LF`, `CR`. These affect cursor movement and terminal state.
- **Escape sequences**: start with `ESC` (`0x1b`) and a final byte. These are
  discrete sequences (for example `ESC D`).
- **C1/Fe sequences** (escape + introducer):
  - **CSI** (`ESC [`): integer parameters (cursor, screen, modes, styles).
  - **OSC** (`ESC ]`): string payloads (title, palette, clipboard, hyperlinks).
  - **DCS** (`ESC P`): integer params + data payload (capability queries).
  - **APC** (`ESC _`): used by complex protocols like Kitty graphics.
  - **SOS/PM**: ignored by Ghostty.

These sequences are the primary “API” a terminal consumes — all VT control sequences
are just bytes written to the PTY input stream.

## Cursor behavior

- The cursor is always present, even when visually hidden.
- It represents the active location for printed characters and
  location‑sensitive sequences (e.g. erase line).
- **Initial position**: top‑left of the active screen.
- **Pending wrap state**: set when printing at the rightmost column, causing the
  next character to wrap. This affects backspace behavior and is a common source
  of prompt bugs.

## Colors

Ghostty emulates:

- **256‑color palette**
- **Special colors** (bold/underline/blink/reverse/italic styling). Query/change
  via `OSC 4` or `OSC 5`.
- **Dynamic colors** (foreground, background, cursor). Query/change via
  `OSC 10–12`.

Color specifications accept:

- Hex RGB (`rgb:rr/gg/bb` or `#rrggbb`, with 4–16 bit channels)
- Intensity RGB (`rgbi:r/g/b`, 0–1)
- Named colors (X11 color names)

## VT reference

Ghostty’s VT reference page enumerates supported sequences (ESC, CSI, OSC).
We rely on that list for compatibility, but Ghostty supports more than the
current documentation lists.

## External protocols

Ghostty exposes external protocol support through standard control sequences,
including:

- `OSC 8` hyperlinks (URI + label)
- `OSC 21` Kitty color protocol
- `DCS`/device attribute exchanges for terminal queries

## What would it take to use Ghostty’s renderer?

Right now we do:

```
PTY bytes -> Ghostty VT -> HTML snapshot -> NSTextView
```

To render with Ghostty’s native renderer we’d need to:

1. **Expose renderer APIs** via the Zig bridge (likely from `renderer.zig`).
2. **Provide a Metal-backed surface** (MTKView) for the Ghostty renderer.
3. **Drive a render loop** and pass grid/cursor updates to the renderer.
4. **Map input + selection** to Ghostty’s expectations (cursor, selection, IME).
5. **Handle DPI/scale and resize** so cell metrics remain correct.

This would give us true terminal rendering (cursor, attributes, glyph metrics)
and avoid HTML snapshot limitations.

### Concrete integration checklist

**Bridge (Zig → C ABI)**

- Export renderer lifecycle:
  - `ghostty_renderer_create(config, metal_device, command_queue, surface)`
  - `ghostty_renderer_destroy`
  - `ghostty_renderer_resize(px_width, px_height, scale)`
- Export VT hooks:
  - `ghostty_vt_feed(bytes)`
  - `ghostty_vt_resize(cols, rows)`
  - `ghostty_vt_set_palette(...)`
  - `ghostty_vt_get_grid_snapshot` (for debug/inspection)
- Export frame render:
  - `ghostty_renderer_draw()` (called from MTKView draw loop)

**Swift/Metal wiring**

- Create an `MTKView` (layer-backed) as the terminal surface.
- Hold `MTLDevice` + `MTLCommandQueue` for the renderer.
- Drive a render loop (MTKView delegate) and call `renderer_draw`.
- Invalidate/re-render on:
  - PTY data arrival
  - Cursor blink timer
  - Size/scale changes

**Sizing + layout**

- On view resize:
  - Compute columns/rows from pixel size and Ghostty cell metrics.
  - Call `vt_resize(cols, rows)` and `ioctl(TIOCSWINSZ)` on the PTY.
- Track backing scale factor (Retina) and send scale to the renderer.

**Input + IME**

- Map `NSEvent` to VT input (including Ctrl/Alt/Shift combos).
- Ensure `TERM` is set to a capable value (`xterm-256color` or Ghostty’s terminfo).
- Support paste + clipboard (OSC 52 if needed later).

**Visual parity**

- Configure background/foreground palette and cursor color.
- Use Ghostty cursor rendering (no NSTextView caret).
- Keep selection + copy behavior in Ghostty (optional for v1).

**Testing**

- Run `vttest` or known ANSI test suites in the embedded shell.
- Validate wrapping, cursor positioning, color attributes, and Unicode width.

## Links

- Ghostty VT Concepts: sequences, cursor, colors
- Ghostty VT Reference (CSI/OSC lists)
- Ghostty VT External protocols
