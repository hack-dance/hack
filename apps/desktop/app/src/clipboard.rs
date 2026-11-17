//! Putting an env value on the clipboard.
//!
//! On macOS the item is also marked concealed (`org.nspasteboard.ConcealedType`),
//! so clipboard managers that follow that convention do not record it. GPUI's
//! clipboard API cannot add that marker, so this writes the pasteboard
//! directly and falls back to GPUI when that fails. Elsewhere there is no such
//! convention: the value goes to the clipboard through GPUI, and the 60 s clear
//! is the only protection.

use gpui_kit::{App, ClipboardItem};

/// Write `text` to the clipboard, marked concealed where the platform has a
/// marker.
pub(crate) fn write_secret(text: &str, cx: &mut App) {
    #[cfg(target_os = "macos")]
    if mac::write_concealed(text) {
        return;
    }
    cx.write_to_clipboard(ClipboardItem::new_string(text.to_owned()));
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::{NSArray, NSString};

    /// The plain-text value plus the concealed marker type, in one
    /// declaration so they are a single clipboard item. Whether the text was
    /// stored.
    pub(super) fn write_concealed(text: &str) -> bool {
        let concealed = NSString::from_str("org.nspasteboard.ConcealedType");
        let pasteboard = NSPasteboard::generalPasteboard();
        // SAFETY: NSPasteboardTypeString is an immutable AppKit constant.
        let string_type = unsafe { NSPasteboardTypeString };
        let types = NSArray::from_slice(&[string_type, &*concealed]);
        // SAFETY: declaring types with no owner is the documented plain form.
        unsafe { pasteboard.declareTypes_owner(&types, None) };
        let stored = pasteboard.setString_forType(&NSString::from_str(text), string_type);
        // The marker's content does not matter; its presence does.
        pasteboard.setString_forType(&NSString::from_str(""), &concealed);
        stored
    }
}
