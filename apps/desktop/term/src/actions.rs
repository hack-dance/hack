//! Keyboard actions for the terminal and its panel.
//!
//! The crate defines these actions and handles them. It binds **no keys**:
//! the only keys it interprets itself are the ones it forwards to the
//! program on the PTY, and text typed into the find field. The app binds
//! keys to these actions in its keymap; `examples/term_spike.rs` has the
//! bindings from the app's design.
//!
//! Key contexts set by the view, for binding predicates: `Terminal` always,
//! `TerminalLogs` on a read-only stream, `TerminalFind` while the find
//! field is open. The panel sets `TerminalPanel`.

use gpui_kit::actions;

actions!(
    hack_term,
    [
        /// Show or hide the terminal panel.
        TogglePanel,
        /// Ask for a new tab. The app decides what kind and adds it.
        NewTab,
        /// Close the active tab and end its session.
        CloseTab,
        /// Activate the next tab, wrapping.
        NextTab,
        /// Activate the previous tab, wrapping.
        PrevTab,
        /// Let the panel take the whole content area, or restore it.
        ToggleMaximize,
        /// Copy the selection to the clipboard.
        Copy,
        /// Paste the clipboard into the program (bracketed when it asked).
        Paste,
        /// Open find in the active terminal.
        Find,
        /// Select the next match toward older output.
        FindOlder,
        /// Select the next match toward newer output.
        FindNewer,
        /// Close find and clear its highlights.
        CloseFind,
        /// Scroll one screen toward older output.
        ScrollPageUp,
        /// Scroll one screen toward newer output.
        ScrollPageDown,
        /// Scroll to the oldest output kept.
        ScrollToTop,
        /// Scroll to the newest output and follow it.
        ScrollToBottom,
        /// Turn following the newest output on or off.
        ToggleFollow,
    ]
);
