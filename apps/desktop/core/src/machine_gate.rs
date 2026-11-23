//! One admission gate for the machine actions the app runs itself: Setup's
//! Start / Install hackd and the project pane's Start / Restart hackd (and
//! the daemon card's, when it exists). Two of them at once could start hackd
//! twice, or restart it under an install that is still running, so a second
//! is refused until the first finishes.
//!
//! Embedded command runs also hold this gate until their process exits.
//! A command handed to the user's terminal is not admitted here: the app
//! only opens the terminal, cannot see the command finish, and must not
//! block recovery for as long as that window stays open. It does not start
//! while an admitted action runs.
//!
//! Each admission gets a [`Ticket`]; only that ticket releases it, so a
//! completion that arrives after a CLI switch ([`MachineGate::reset`]) cannot
//! release an action admitted since.

/// Who holds the gate: the window labels that one as working.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Holder {
    /// A checked command running in the embedded terminal.
    Command,
    /// A Setup action (Start or Install hackd).
    Setup,
    /// Start or Restart hackd from the project pane.
    Recovery,
    /// An upgrade snapshot or restore (files under the CLI's home and in
    /// registered checkouts).
    Upgrade,
}

/// Proof of admission; pass it back to [`MachineGate::finish`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[must_use]
pub struct Ticket {
    id: u64,
    holder: Holder,
}

impl Ticket {
    #[must_use]
    pub fn holder(&self) -> Holder {
        self.holder
    }
}

#[derive(Debug, Default)]
pub struct MachineGate {
    held: Option<Ticket>,
    issued: u64,
}

impl MachineGate {
    /// Admit one action, or `None` while another runs.
    pub fn try_begin(&mut self, holder: Holder) -> Option<Ticket> {
        if self.held.is_some() {
            return None;
        }
        self.issued += 1;
        let ticket = Ticket {
            id: self.issued,
            holder,
        };
        self.held = Some(ticket);
        Some(ticket)
    }

    /// Release `ticket`'s admission. Returns whether it still held the
    /// gate (false after a reset, or for another ticket).
    pub fn finish(&mut self, ticket: Ticket) -> bool {
        if self.held == Some(ticket) {
            self.held = None;
            true
        } else {
            false
        }
    }

    /// Another CLI is selected: an action still running belongs to the
    /// previous install and must not block this one.
    pub fn reset(&mut self) {
        self.held = None;
    }

    #[must_use]
    pub fn busy(&self) -> bool {
        self.held.is_some()
    }

    #[must_use]
    pub fn held_by(&self, holder: Holder) -> bool {
        self.held.is_some_and(|t| t.holder == holder)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_and_recovery_share_one_gate() {
        let mut gate = MachineGate::default();
        let setup = gate.try_begin(Holder::Setup).unwrap();
        assert!(gate.try_begin(Holder::Recovery).is_none());
        assert!(gate.try_begin(Holder::Setup).is_none());
        assert!(gate.held_by(Holder::Setup) && !gate.held_by(Holder::Recovery));
        assert!(gate.finish(setup));
        let recovery = gate.try_begin(Holder::Recovery).unwrap();
        assert!(gate.try_begin(Holder::Setup).is_none());
        assert!(gate.finish(recovery));
        assert!(!gate.busy());
    }

    #[test]
    fn a_completion_after_a_cli_switch_never_releases_a_newer_action() {
        let mut gate = MachineGate::default();
        let old = gate.try_begin(Holder::Recovery).unwrap();
        gate.reset();
        let new = gate.try_begin(Holder::Setup).unwrap();
        assert!(!gate.finish(old), "the old install's action ended late");
        assert!(gate.busy() && gate.held_by(Holder::Setup));
        assert!(gate.finish(new));
    }
}
