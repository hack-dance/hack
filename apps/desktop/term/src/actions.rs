//! Keyboard actions for the terminal panel and its tabs.
//!
//! The crate defines the actions and handles them; it binds no keys. The
//! app binds keys to these in its keymap (`KeyBinding::new("ctrl-`",
//! TogglePanel, None)` and so on).

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
        /// Open find in the active terminal.
        Find,
    ]
);
