//! Glyphs the terminal draws itself, as geometry that fits the cell exactly.
//!
//! Three families are drawn here instead of taken from a font, the way
//! Ghostty's renderer does it:
//!
//! - box drawing, U+2500..U+257F;
//! - block elements, U+2580..U+259F;
//! - the geometric powerline separators, U+E0B0..U+E0BF.
//!
//! A font's versions of these rarely meet the edges of the cell, so lines
//! break between rows and prompt segments show seams. Drawn as geometry in
//! whole device pixels they join at any font size, with any font.
//!
//! This module only computes shapes; it has no GUI in it. The view paints
//! them. The pictographs next to the separators (branch U+E0A0, line number
//! U+E0A1, padlock U+E0A2, column U+E0A3) are icons, not cell geometry, and
//! come from the symbols font; Ghostty does the same.
//!
//! The box-drawing table is derived from the Unicode character names (each
//! name says which arms a character has and how heavy they are). The
//! geometry is written for this crate; it is not a port of Ghostty's code.

/// One command of a path, in cell pixels from the cell's top-left corner.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Seg {
    Move(f32, f32),
    Line(f32, f32),
    /// A cubic Bézier: two control points, then the end point.
    Cubic((f32, f32), (f32, f32), (f32, f32)),
    /// Close the current contour. A path may hold several.
    Close,
}

/// One piece of a glyph.
#[derive(Clone, Debug, PartialEq)]
pub enum Shape {
    /// A filled rectangle. `alpha` scales the colour (the shade blocks).
    Rect {
        x0: f32,
        y0: f32,
        x1: f32,
        y1: f32,
        alpha: f32,
    },
    /// A filled, closed path.
    Fill(Vec<Seg>),
    /// A stroked, open path.
    Stroke { path: Vec<Seg>, width: f32 },
}

/// Whether `ch` is drawn by this module.
pub fn covers(ch: char) -> bool {
    matches!(ch, '\u{2500}'..='\u{259f}' | '\u{e0b0}'..='\u{e0bf}')
}

/// The thickness of a light line for a cell `w` device pixels wide.
pub fn line_thickness(w: f32) -> f32 {
    (w / 8.0).round().max(1.0)
}

/// The shapes for `ch` in a cell of `w` by `h` device pixels, with light
/// lines `t` device pixels thick. All three are whole numbers, so every
/// rectangle lands on pixel boundaries. `None` when `ch` is not drawn here.
pub fn shapes(ch: char, w: f32, h: f32, t: f32) -> Option<Vec<Shape>> {
    let t = t.max(1.0);
    let mut out = Vec::new();
    match ch {
        '\u{2500}'..='\u{257f}' => box_drawing(BOX[ch as usize - 0x2500], w, h, t, &mut out),
        '\u{2580}'..='\u{259f}' => block(ch, w, h, &mut out),
        '\u{e0b0}'..='\u{e0bf}' => powerline(ch, w, h, t, &mut out),
        _ => return None,
    }
    Some(out)
}

fn rect(out: &mut Vec<Shape>, x0: f32, y0: f32, x1: f32, y1: f32) {
    if x1 > x0 && y1 > y0 {
        out.push(Shape::Rect {
            x0,
            y0,
            x1,
            y1,
            alpha: 1.0,
        });
    }
}

// --- box drawing -----------------------------------------------------------

/// Arms and kind for U+2500..U+257F. Two bits per arm (0 none, 1 light,
/// 2 heavy, 3 double) in the order up, right, down, left; the kind in bits
/// 8..11: 0 lines, 2/3/4 that many dashes, 5 arc, 6 "/", 7 "\\", 8 both.
#[rustfmt::skip]
const BOX: [u16; 128] = [
    0x0044, 0x0088, 0x0011, 0x0022, 0x0344, 0x0388, 0x0311, 0x0322, // U+2500
    0x0444, 0x0488, 0x0411, 0x0422, 0x0014, 0x0018, 0x0024, 0x0028, // U+2508
    0x0050, 0x0090, 0x0060, 0x00a0, 0x0005, 0x0009, 0x0006, 0x000a, // U+2510
    0x0041, 0x0081, 0x0042, 0x0082, 0x0015, 0x0019, 0x0016, 0x0025, // U+2518
    0x0026, 0x001a, 0x0029, 0x002a, 0x0051, 0x0091, 0x0052, 0x0061, // U+2520
    0x0062, 0x0092, 0x00a1, 0x00a2, 0x0054, 0x0094, 0x0058, 0x0098, // U+2528
    0x0064, 0x00a4, 0x0068, 0x00a8, 0x0045, 0x0085, 0x0049, 0x0089, // U+2530
    0x0046, 0x0086, 0x004a, 0x008a, 0x0055, 0x0095, 0x0059, 0x0099, // U+2538
    0x0056, 0x0065, 0x0066, 0x0096, 0x005a, 0x00a5, 0x0069, 0x009a, // U+2540
    0x00a9, 0x00a6, 0x006a, 0x00aa, 0x0244, 0x0288, 0x0211, 0x0222, // U+2548
    0x00cc, 0x0033, 0x001c, 0x0034, 0x003c, 0x00d0, 0x0070, 0x00f0, // U+2550
    0x000d, 0x0007, 0x000f, 0x00c1, 0x0043, 0x00c3, 0x001d, 0x0037, // U+2558
    0x003f, 0x00d1, 0x0073, 0x00f3, 0x00dc, 0x0074, 0x00fc, 0x00cd, // U+2560
    0x0047, 0x00cf, 0x00dd, 0x0077, 0x00ff, 0x0514, 0x0550, 0x0541, // U+2568
    0x0505, 0x0600, 0x0700, 0x0800, 0x0040, 0x0001, 0x0004, 0x0010, // U+2570
    0x0080, 0x0002, 0x0008, 0x0020, 0x0048, 0x0021, 0x0084, 0x0012, // U+2578
];

const NONE: u8 = 0;
const HEAVY: u8 = 2;
const DOUBLE: u8 = 3;

/// Where lines sit across one dimension of the cell. A light line occupies
/// `[l0, l1)`, a heavy one `[h0, h1)`, and the two lines of a double line
/// `[d0, l0)` and `[l1, d3)`: a light-line-wide gap between them.
#[derive(Clone, Copy)]
struct Axis {
    n: f32,
    l0: f32,
    l1: f32,
    h0: f32,
    h1: f32,
    d0: f32,
    d3: f32,
    mid: f32,
}

impl Axis {
    fn new(n: f32, t: f32) -> Self {
        let l0 = ((n - t) / 2.0).floor();
        let h0 = ((n - 2.0 * t) / 2.0).floor().max(0.0);
        Self {
            n,
            l0,
            l1: l0 + t,
            h0,
            h1: (h0 + 2.0 * t).min(n),
            d0: (l0 - t).max(0.0),
            d3: (l0 + 2.0 * t).min(n),
            mid: (n / 2.0).floor(),
        }
    }
}

/// How an arm ends at the centre of the cell.
#[derive(Clone, Copy)]
enum Join {
    /// Reach the far line of a perpendicular double line: an outer corner.
    Outer,
    /// Stop at the near line of a perpendicular double line.
    Inner,
    /// Cover a perpendicular single line, light or heavy.
    Touch { heavy: bool },
    /// Nothing to meet: a half line.
    Lone,
}

/// The coordinate at which an arm ends at the centre. `forward` arms (right
/// and down) run from there to the far edge, the others from 0 to there.
fn join_at(a: Axis, join: Join, forward: bool) -> f32 {
    match (join, forward) {
        (Join::Outer, true) => a.d0,
        (Join::Outer, false) => a.d3,
        (Join::Inner, true) => a.l1,
        (Join::Inner, false) => a.l0,
        (Join::Touch { heavy: true }, true) => a.h0,
        (Join::Touch { heavy: true }, false) => a.h1,
        (Join::Touch { heavy: false }, true) => a.l0,
        (Join::Touch { heavy: false }, false) => a.l1,
        (Join::Lone, _) => a.mid,
    }
}

fn box_drawing(entry: u16, w: f32, h: f32, t: f32, out: &mut Vec<Shape>) {
    let arms = [
        (entry & 3) as u8,
        (entry >> 2 & 3) as u8,
        (entry >> 4 & 3) as u8,
        (entry >> 6 & 3) as u8,
    ];
    let (x, y) = (Axis::new(w, t), Axis::new(h, t));
    match entry >> 8 {
        0 => box_lines(arms, x, y, out),
        dashes @ 2..=4 => box_dashes(arms, x, y, f32::from(dashes), out),
        5 => box_arc(arms, x, y, t, out),
        kind => {
            if kind == 6 || kind == 8 {
                out.push(Shape::Stroke {
                    path: vec![Seg::Move(w, 0.0), Seg::Line(0.0, h)],
                    width: t,
                });
            }
            if kind == 7 || kind == 8 {
                out.push(Shape::Stroke {
                    path: vec![Seg::Move(0.0, 0.0), Seg::Line(w, h)],
                    width: t,
                });
            }
        }
    }
}

fn box_lines(arms: [u8; 4], x: Axis, y: Axis, out: &mut Vec<Shape>) {
    for (i, &weight) in arms.iter().enumerate() {
        if weight == NONE {
            continue;
        }
        let horizontal = i % 2 == 1;
        let forward = i == 1 || i == 2;
        // The axis the arm runs along, and the one its thickness is on.
        let (along, cross) = if horizontal { (x, y) } else { (y, x) };
        // The perpendicular arms, at the smaller and the larger cross
        // coordinate: up and down for a horizontal arm, left and right for
        // a vertical one. And the arm straight across the centre.
        let (before, after) = if horizontal {
            (arms[0], arms[2])
        } else {
            (arms[3], arms[1])
        };
        let opposite = arms[(i + 2) % 4];
        let single_touch = || {
            if before != NONE || after != NONE {
                Join::Touch {
                    heavy: before == HEAVY || after == HEAVY,
                }
            } else if opposite != NONE {
                Join::Touch { heavy: false }
            } else {
                Join::Lone
            }
        };
        let mut line = |c0: f32, c1: f32, join: Join| {
            let at = join_at(along, join, forward);
            let (a0, a1) = if forward { (at, along.n) } else { (0.0, at) };
            if horizontal {
                rect(out, a0, c0, a1, c1);
            } else {
                rect(out, c0, a0, c1, a1);
            }
        };
        if weight == DOUBLE {
            // One line on each side of the centre. Each joins the double
            // line on its own side, or wraps around the one on the other.
            for (c0, c1, side, other) in [
                (cross.d0, cross.l0, before, after),
                (cross.l1, cross.d3, after, before),
            ] {
                let join = if side == DOUBLE {
                    Join::Inner
                } else if other == DOUBLE {
                    Join::Outer
                } else {
                    single_touch()
                };
                line(c0, c1, join);
            }
        } else {
            let (c0, c1) = if weight == HEAVY {
                (cross.h0, cross.h1)
            } else {
                (cross.l0, cross.l1)
            };
            let join = match (before == DOUBLE, after == DOUBLE) {
                // Crossing a double line: pass through, or stop at it.
                (true, true) if opposite != NONE => Join::Touch { heavy: false },
                (true, true) => Join::Inner,
                // A corner with a double line: reach its outer line.
                (true, false) | (false, true) => Join::Outer,
                (false, false) => single_touch(),
            };
            line(c0, c1, join);
        }
    }
}

fn box_dashes(arms: [u8; 4], x: Axis, y: Axis, count: f32, out: &mut Vec<Shape>) {
    let horizontal = arms[1] != NONE;
    let weight = if horizontal { arms[1] } else { arms[0] };
    let (along, cross) = if horizontal { (x, y) } else { (y, x) };
    let (c0, c1) = if weight == HEAVY {
        (cross.h0, cross.h1)
    } else {
        (cross.l0, cross.l1)
    };
    let step = along.n / count;
    if step < 2.0 {
        // Too small a cell for separate dashes: a solid line.
        if horizontal {
            rect(out, 0.0, c0, along.n, c1);
        } else {
            rect(out, c0, 0.0, c1, along.n);
        }
        return;
    }
    let gap = (step / 4.0).round().max(1.0);
    for i in 0..count as usize {
        let a0 = (i as f32 * step + gap / 2.0).round();
        let a1 = ((i + 1) as f32 * step - gap / 2.0).round();
        if horizontal {
            rect(out, a0, c0, a1, c1);
        } else {
            rect(out, c0, a0, c1, a1);
        }
    }
}

/// How far along a quarter circle's tangent a cubic's control point sits.
const KAPPA: f32 = 0.552_284_8;

fn box_arc(arms: [u8; 4], x: Axis, y: Axis, t: f32, out: &mut Vec<Shape>) {
    let (cx, cy) = (x.l0 + t / 2.0, y.l0 + t / 2.0);
    let r = (x.n.min(y.n) / 2.0).floor();
    // The vertical arm goes up (-1) or down (+1); the horizontal one left
    // (-1) or right (+1).
    let v = if arms[0] != NONE { -1.0 } else { 1.0 };
    let u = if arms[3] != NONE { -1.0 } else { 1.0 };
    let k = r * (1.0 - KAPPA);
    out.push(Shape::Stroke {
        path: vec![
            Seg::Move(cx, if v > 0.0 { y.n } else { 0.0 }),
            Seg::Line(cx, cy + v * r),
            Seg::Cubic((cx, cy + v * k), (cx + u * k, cy), (cx + u * r, cy)),
            Seg::Line(if u > 0.0 { x.n } else { 0.0 }, cy),
        ],
        width: t,
    });
}

// --- block elements --------------------------------------------------------

fn block(ch: char, w: f32, h: f32, out: &mut Vec<Shape>) {
    let eighth_y = |i: u32| (h * i as f32 / 8.0).round();
    let eighth_x = |i: u32| (w * i as f32 / 8.0).round();
    let (hx, hy) = (eighth_x(4), eighth_y(4));
    let shade = |out: &mut Vec<Shape>, alpha: f32| {
        out.push(Shape::Rect {
            x0: 0.0,
            y0: 0.0,
            x1: w,
            y1: h,
            alpha,
        });
    };
    // Quadrants as bits: upper left 1, upper right 2, lower left 4, lower right 8.
    let quadrants = |out: &mut Vec<Shape>, bits: u8| {
        for (bit, x0, y0, x1, y1) in [
            (1, 0.0, 0.0, hx, hy),
            (2, hx, 0.0, w, hy),
            (4, 0.0, hy, hx, h),
            (8, hx, hy, w, h),
        ] {
            if bits & bit != 0 {
                rect(out, x0, y0, x1, y1);
            }
        }
    };
    match ch as u32 {
        0x2580 => rect(out, 0.0, 0.0, w, hy),
        // Lower one eighth up to the full block.
        // Never thinner than one pixel, however small the cell.
        cp @ 0x2581..=0x2588 => rect(out, 0.0, eighth_y(0x2588 - cp).min(h - 1.0), w, h),
        // Left seven eighths down to left one eighth.
        cp @ 0x2589..=0x258f => rect(out, 0.0, 0.0, eighth_x(0x2590 - cp).max(1.0), h),
        0x2590 => rect(out, hx, 0.0, w, h),
        0x2591 => shade(out, 0.25),
        0x2592 => shade(out, 0.5),
        0x2593 => shade(out, 0.75),
        0x2594 => rect(out, 0.0, 0.0, w, eighth_y(1).max(1.0)),
        0x2595 => rect(out, eighth_x(7).min(w - 1.0), 0.0, w, h),
        0x2596 => quadrants(out, 4),
        0x2597 => quadrants(out, 8),
        0x2598 => quadrants(out, 1),
        0x2599 => quadrants(out, 1 | 4 | 8),
        0x259a => quadrants(out, 1 | 8),
        0x259b => quadrants(out, 1 | 2 | 4),
        0x259c => quadrants(out, 1 | 2 | 8),
        0x259d => quadrants(out, 2),
        0x259e => quadrants(out, 2 | 4),
        _ => quadrants(out, 2 | 4 | 8),
    }
}

// --- powerline -------------------------------------------------------------

fn powerline(ch: char, w: f32, h: f32, t: f32, out: &mut Vec<Shape>) {
    let mid = h / 2.0;
    let triangle = |out: &mut Vec<Shape>, p: [(f32, f32); 3]| {
        out.push(Shape::Fill(vec![
            Seg::Move(p[0].0, p[0].1),
            Seg::Line(p[1].0, p[1].1),
            Seg::Line(p[2].0, p[2].1),
        ]));
    };
    let stroke = |out: &mut Vec<Shape>, path: Vec<Seg>| {
        out.push(Shape::Stroke { path, width: t });
    };
    // Half an ellipse with its flat side on the cell's left edge (`flat` 0)
    // or right edge (`flat` w), bulging to the other edge.
    let half_round = |flat: f32| {
        let far = w - flat;
        let toward = |f: f32| flat + (far - flat) * f;
        vec![
            Seg::Move(flat, 0.0),
            Seg::Cubic((toward(KAPPA), 0.0), (far, mid - mid * KAPPA), (far, mid)),
            Seg::Cubic((far, mid + mid * KAPPA), (toward(KAPPA), h), (flat, h)),
        ]
    };
    match ch as u32 {
        0xe0b0 => triangle(out, [(0.0, 0.0), (w, mid), (0.0, h)]),
        0xe0b1 => stroke(
            out,
            vec![Seg::Move(0.0, 0.0), Seg::Line(w, mid), Seg::Line(0.0, h)],
        ),
        0xe0b2 => triangle(out, [(w, 0.0), (0.0, mid), (w, h)]),
        0xe0b3 => stroke(
            out,
            vec![Seg::Move(w, 0.0), Seg::Line(0.0, mid), Seg::Line(w, h)],
        ),
        0xe0b4 => out.push(Shape::Fill(half_round(0.0))),
        0xe0b5 => stroke(out, half_round(0.0)),
        0xe0b6 => out.push(Shape::Fill(half_round(w))),
        0xe0b7 => stroke(out, half_round(w)),
        0xe0b8 => triangle(out, [(0.0, 0.0), (w, h), (0.0, h)]),
        0xe0ba => triangle(out, [(w, 0.0), (w, h), (0.0, h)]),
        0xe0bc => triangle(out, [(0.0, 0.0), (w, 0.0), (0.0, h)]),
        0xe0be => triangle(out, [(0.0, 0.0), (w, 0.0), (w, h)]),
        // Thin separators: the diagonal of the triangle beside them.
        0xe0b9 | 0xe0bf => stroke(out, vec![Seg::Move(0.0, 0.0), Seg::Line(w, h)]),
        _ => stroke(out, vec![Seg::Move(w, 0.0), Seg::Line(0.0, h)]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: usize = 9;
    const H: usize = 20;

    /// The pixels a glyph's rectangles cover. Glyphs made of paths (arcs,
    /// diagonals, powerline) are not rasterised here.
    fn raster(ch: char, t: f32) -> Vec<Vec<bool>> {
        let mut grid = vec![vec![false; W]; H];
        for shape in shapes(ch, W as f32, H as f32, t).expect("covered") {
            let Shape::Rect { x0, y0, x1, y1, .. } = shape else {
                panic!("{ch:?} is not made of rectangles");
            };
            for (v, limit) in [(x0, W), (x1, W), (y0, H), (y1, H)] {
                assert_eq!(v.fract(), 0.0, "{ch:?}: {v} is not a whole pixel");
                assert!(
                    v >= 0.0 && v <= limit as f32,
                    "{ch:?}: {v} outside the cell"
                );
            }
            for row in &mut grid[y0 as usize..y1 as usize] {
                for cell in &mut row[x0 as usize..x1 as usize] {
                    *cell = true;
                }
            }
        }
        grid
    }

    fn column(grid: &[Vec<bool>], x: usize) -> Vec<bool> {
        grid.iter().map(|row| row[x]).collect()
    }

    fn arms(ch: char) -> [u8; 4] {
        let e = BOX[ch as usize - 0x2500];
        [0, 2, 4, 6].map(|shift| (e >> shift & 3) as u8)
    }

    fn is_lines(ch: char) -> bool {
        BOX[ch as usize - 0x2500] >> 8 == 0
    }

    #[test]
    fn the_three_families_and_nothing_else_are_covered() {
        for ch in ['─', '╿', '▀', '▟', '\u{e0b0}', '\u{e0bf}'] {
            assert!(covers(ch) && shapes(ch, 9., 20., 1.).is_some(), "{ch:?}");
        }
        // Letters, and the pictographs that come from the symbols font.
        for ch in [
            'a', '\u{24ff}', '\u{25a0}', '\u{e0a0}', '\u{e0a3}', '\u{e0c0}', '\u{f418}',
        ] {
            assert!(!covers(ch) && shapes(ch, 9., 20., 1.).is_none(), "{ch:?}");
        }
        // Every covered character draws something, from a very small cell
        // (a double line needs three pixels) to a large one.
        for (w, h) in [(4., 8.), (7., 15.), (8., 17.), (9., 20.), (16., 35.)] {
            for cp in (0x2500..=0x259f).chain(0xe0b0..=0xe0bf) {
                let ch = char::from_u32(cp).unwrap();
                let drawn = shapes(ch, w, h, line_thickness(w)).unwrap();
                assert!(!drawn.is_empty(), "U+{cp:04X} at {w}x{h} draws nothing");
            }
        }
    }

    #[test]
    fn lines_reach_exactly_the_edges_their_arms_point_at() {
        for cp in 0x2500..=0x257f_u32 {
            let ch = char::from_u32(cp).unwrap();
            if !is_lines(ch) {
                continue;
            }
            for t in [1.0, 2.0] {
                let g = raster(ch, t);
                let a = arms(ch);
                let touches = [
                    g[0].iter().any(|&p| p),
                    column(&g, W - 1).iter().any(|&p| p),
                    g[H - 1].iter().any(|&p| p),
                    column(&g, 0).iter().any(|&p| p),
                ];
                for (i, name) in ["top", "right", "bottom", "left"].iter().enumerate() {
                    assert_eq!(
                        touches[i],
                        a[i] != NONE,
                        "U+{cp:04X} {ch} t={t}: {name} edge"
                    );
                }
            }
        }
    }

    #[test]
    fn neighbouring_cells_join_without_a_step_or_a_gap() {
        // What an arm of each weight looks like where it meets the cell's
        // edge must not depend on the character: then any two characters
        // whose arms face each other line up.
        for t in [1.0, 2.0] {
            // [weight][0 = horizontal edge pattern, 1 = vertical edge pattern]
            let mut seen: [[Option<Vec<bool>>; 2]; 4] = Default::default();
            for cp in 0x2500..=0x257f_u32 {
                let ch = char::from_u32(cp).unwrap();
                if !is_lines(ch) {
                    continue;
                }
                let g = raster(ch, t);
                let a = arms(ch);
                let edges = [
                    (a[0], 1, g[0].clone()),
                    (a[1], 0, column(&g, W - 1)),
                    (a[2], 1, g[H - 1].clone()),
                    (a[3], 0, column(&g, 0)),
                ];
                for (weight, axis, pattern) in edges {
                    if weight == NONE {
                        continue;
                    }
                    let slot = &mut seen[weight as usize][axis];
                    match slot {
                        None => *slot = Some(pattern),
                        Some(first) => assert_eq!(
                            *first, pattern,
                            "U+{cp:04X} {ch} t={t}: weight {weight} meets the edge differently"
                        ),
                    }
                }
            }
            // Light is one line, heavy is twice as thick, double is two
            // lines with a gap.
            let runs = |p: &Vec<bool>| {
                let mut out = Vec::new();
                let mut n = 0;
                for &on in p.iter().chain([&false]) {
                    if on {
                        n += 1;
                    } else if n > 0 {
                        out.push(n);
                        n = 0;
                    }
                }
                out
            };
            let t = t as usize;
            assert_eq!(runs(seen[1][0].as_ref().unwrap()), [t]);
            assert_eq!(runs(seen[2][0].as_ref().unwrap()), [2 * t]);
            assert_eq!(runs(seen[3][0].as_ref().unwrap()), [t, t]);
            assert_eq!(runs(seen[3][1].as_ref().unwrap()), [t, t]);
        }
    }

    #[test]
    fn corners_are_closed_and_double_crossings_are_hollow() {
        let lit = |ch: char, x: usize, y: usize| raster(ch, 1.0)[y][x];
        // Light line position at this size: x 4, y 9.
        // A light corner has its corner pixel.
        for ch in ['┌', '┐', '└', '┘', '┼', '├', '┬'] {
            assert!(lit(ch, 4, 9), "{ch}: the corner pixel is missing");
        }
        assert!(
            !lit('┌', 3, 9) && !lit('┌', 4, 8),
            "┌ has no left or up arm"
        );
        // A double corner: outer and inner corners are both closed, and
        // the gap between the lines stays open.
        assert!(lit('╔', 3, 8), "╔ outer corner");
        assert!(lit('╔', 5, 10), "╔ inner corner");
        assert!(!lit('╔', 4, 9), "╔ gap between the two lines");
        assert!(
            !lit('╔', 2, 9) && !lit('╔', 4, 7),
            "╔ has no left or up arm"
        );
        // All four double arms: the centre and the gaps are hollow.
        for (x, y) in [(4, 9), (4, 0), (0, 9), (8, 9), (4, 19)] {
            assert!(!lit('╬', x, y), "╬ should be open at {x},{y}");
        }
        assert!(lit('╬', 3, 0) && lit('╬', 5, 0) && lit('╬', 0, 8) && lit('╬', 0, 10));
        // A single line stops at a double line it does not cross, and
        // passes through one it does.
        assert!(
            !lit('╟', 4, 9),
            "╟: the single arm starts at the right-hand line"
        );
        assert!(lit('╫', 4, 9), "╫: the single line passes through");
        assert!(
            !lit('╤', 4, 9) && lit('╤', 4, 10),
            "╤: the stem starts at the lower line"
        );
        // Half lines stop at the middle.
        assert!(lit('╴', 0, 9) && !lit('╴', 8, 9));
        assert!(lit('╷', 4, 19) && !lit('╷', 4, 0));
    }

    #[test]
    fn dashes_blocks_and_shades_have_the_right_coverage() {
        // Dashes: that many separate runs along the line.
        for (ch, count) in [('╌', 2), ('┄', 3), ('┈', 4)] {
            let row = &raster(ch, 1.0)[9];
            let runs = row.windows(2).filter(|p| !p[0] && p[1]).count() + usize::from(row[0]);
            assert_eq!(runs, count, "{ch}");
        }
        let area = |ch: char| raster(ch, 1.0).iter().flatten().filter(|&&p| p).count();
        assert_eq!(area('█'), W * H, "the full block fills the cell");
        assert_eq!(area('▀') + area('▄'), W * H, "upper and lower halves tile");
        assert_eq!(area('▌') + area('▐'), W * H, "left and right halves tile");
        assert_eq!(area('▚') + area('▞'), W * H, "the two diagonals tile");
        assert_eq!(area('▙') + area('▝'), W * H);
        assert!(area('▁') < area('▂') && area('▂') < area('▇') && area('▇') < area('█'));
        assert!(area('▏') < area('▎') && area('▎') < area('▉'));
        let g = raster('▁', 1.0);
        assert!(g[H - 1][0] && !g[0][0], "the lower eighth is at the bottom");
        // Shades are the whole cell at part strength.
        for (ch, alpha) in [('░', 0.25), ('▒', 0.5), ('▓', 0.75)] {
            assert_eq!(
                shapes(ch, 9., 20., 1.).unwrap(),
                [Shape::Rect {
                    x0: 0.,
                    y0: 0.,
                    x1: 9.,
                    y1: 20.,
                    alpha
                }]
            );
        }
    }

    #[test]
    fn powerline_separators_span_the_whole_cell() {
        let (w, h) = (9.0, 20.0);
        let fill = |ch: char| match shapes(ch, w, h, 1.).unwrap().as_slice() {
            [Shape::Fill(path)] => path.clone(),
            other => panic!("{ch:?}: {other:?}"),
        };
        // The solid arrows: flat on one edge, their point on the other, the
        // full height, so adjacent segments meet with no seam.
        assert_eq!(
            fill('\u{e0b0}'),
            [Seg::Move(0., 0.), Seg::Line(w, h / 2.), Seg::Line(0., h)]
        );
        assert_eq!(
            fill('\u{e0b2}'),
            [Seg::Move(w, 0.), Seg::Line(0., h / 2.), Seg::Line(w, h)]
        );
        // The four corner triangles.
        assert_eq!(
            fill('\u{e0b8}'),
            [Seg::Move(0., 0.), Seg::Line(w, h), Seg::Line(0., h)]
        );
        assert_eq!(
            fill('\u{e0ba}'),
            [Seg::Move(w, 0.), Seg::Line(w, h), Seg::Line(0., h)]
        );
        assert_eq!(
            fill('\u{e0bc}'),
            [Seg::Move(0., 0.), Seg::Line(w, 0.), Seg::Line(0., h)]
        );
        assert_eq!(
            fill('\u{e0be}'),
            [Seg::Move(0., 0.), Seg::Line(w, 0.), Seg::Line(w, h)]
        );
        // The round caps start and end on the flat edge and reach the other.
        for (ch, flat, far) in [('\u{e0b4}', 0., w), ('\u{e0b6}', w, 0.)] {
            let path = fill(ch);
            assert_eq!(path[0], Seg::Move(flat, 0.));
            assert!(
                matches!(path[1], Seg::Cubic(_, _, to) if to == (far, h / 2.)),
                "{path:?}"
            );
            assert!(
                matches!(path[2], Seg::Cubic(_, _, to) if to == (flat, h)),
                "{path:?}"
            );
        }
        // The thin variants are strokes along the same outlines.
        for ch in [
            '\u{e0b1}', '\u{e0b3}', '\u{e0b5}', '\u{e0b7}', '\u{e0b9}', '\u{e0bb}', '\u{e0bd}',
            '\u{e0bf}',
        ] {
            assert!(
                matches!(shapes(ch, w, h, 1.).unwrap().as_slice(), [Shape::Stroke { width, .. }] if *width == 1.),
                "{ch:?}"
            );
        }
        // Arcs and diagonals of the box-drawing block are strokes too.
        for ch in ['╭', '╮', '╯', '╰', '╱', '╲'] {
            assert!(
                matches!(
                    shapes(ch, w, h, 1.).unwrap().as_slice(),
                    [Shape::Stroke { .. }]
                ),
                "{ch}"
            );
        }
        assert_eq!(shapes('╳', w, h, 1.).unwrap().len(), 2);
        // An arc ends at the middles of the two edges its arms point at.
        let Shape::Stroke { path, .. } = &shapes('╭', w, h, 1.).unwrap()[0] else {
            unreachable!()
        };
        assert_eq!(path[0], Seg::Move(4.5, h), "down");
        assert_eq!(path[3], Seg::Line(w, 9.5), "right");
    }
}
