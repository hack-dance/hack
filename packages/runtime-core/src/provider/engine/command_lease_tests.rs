//! HACK-2669: a service command waits out a briefly held provider lease.
//!
//! A ready foreground owner takes the mutation lease for a moment once a second
//! (restart supervision of a routed service). `hack exec` used a nonblocking
//! acquisition, so it was refused `provider_busy` ("recorded holder: start")
//! whenever it arrived during one of those moments. No VM is involved here: the
//! pool record says running, so after acquisition the liveness check refuses
//! with a different code, which shows the lease itself was acquired.
use super::*;
use crate::provider::{Profile, state};
use std::fs;
use std::os::unix::fs::DirBuilderExt;
use std::path::PathBuf;
use std::sync::mpsc;

struct Home {
    checkout: PathBuf,
    alias: Option<PathBuf>,
}

impl Drop for Home {
    fn drop(&mut self) {
        if let Some(alias) = &self.alias {
            if fs::read_link(alias).is_ok_and(|target| target.starts_with(&self.checkout)) {
                let _ = fs::remove_file(alias);
            }
        }
        let _ = fs::remove_dir_all(&self.checkout);
    }
}

fn running_pool() -> (Home, Candidate) {
    let mut bytes = [0_u8; 16];
    std::io::Read::read_exact(&mut fs::File::open("/dev/urandom").unwrap(), &mut bytes).unwrap();
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let checkout = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("hack-command-lease-{token}"));
    fs::DirBuilder::new().mode(0o700).create(&checkout).unwrap();
    let mut home = Home {
        checkout,
        alias: None,
    };
    let candidate = Candidate::discover(&home.checkout).unwrap();
    let mut owner =
        state::Owner::create(&candidate, Profile::Development, None, Default::default()).unwrap();
    home.alias = Some(owner.short_home.clone());
    owner.phase = "running".into();
    owner.guest_boot_id = Some("a1234567-1234-4123-8123-a12345678901".into());
    owner.save(&candidate).unwrap();
    (home, candidate)
}

/// Hold the provider lease on another thread, as the ready owner's supervision
/// tick does, until `release` is signalled or `hold` elapses.
fn hold_lease(
    candidate: &Candidate,
    hold: Duration,
) -> (mpsc::Sender<()>, std::thread::JoinHandle<()>) {
    let root = candidate.state_root.join("run/smolvm");
    let (held_tx, held_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let holder = std::thread::spawn(move || {
        let lock = state::Lock::acquire(&root).unwrap();
        held_tx.send(()).unwrap();
        let _ = release_rx.recv_timeout(hold);
        drop(lock);
    });
    held_rx.recv().unwrap();
    (release_tx, holder)
}

#[test]
fn a_service_command_waits_for_a_briefly_held_lease_instead_of_refusing() {
    let (_home, candidate) = running_pool();
    let hold = Duration::from_millis(400);
    let (_release, holder) = hold_lease(&candidate, hold);

    // What exec did before: refused at once, naming the holder.
    let refused = Engine::connect(&candidate).err().unwrap();
    assert_eq!(refused.code, "provider_busy");
    assert!(
        refused.message.contains("recorded holder:"),
        "{}",
        refused.message
    );

    let started = Instant::now();
    let after = Engine::connect_command(&candidate).err().unwrap();
    assert!(
        started.elapsed() >= hold - Duration::from_millis(50),
        "returned before the holder released: {:?}",
        started.elapsed()
    );
    // Past acquisition: the pool record says running but no VM exists, so the
    // post-acquisition liveness check refuses. Anything but provider_busy.
    assert_ne!(after.code, "provider_busy", "{}", after.message);
    holder.join().unwrap();
}

#[test]
fn a_bounded_command_lease_wait_still_refuses_a_holder_that_keeps_it() {
    let (_home, candidate) = running_pool();
    let (release, holder) = hold_lease(&candidate, Duration::from_secs(30));

    let started = Instant::now();
    let deadline = started + Duration::from_millis(300);
    let refused = OwnedGuest::connect_until(&candidate, deadline)
        .err()
        .unwrap();
    assert_eq!(refused.code, "provider_busy");
    // The last refusal is kept, so the holder is still named.
    assert!(
        refused.message.contains("recorded holder:"),
        "{}",
        refused.message
    );
    assert!(started.elapsed() >= Duration::from_millis(250));
    assert!(started.elapsed() < Duration::from_secs(5));
    release.send(()).unwrap();
    holder.join().unwrap();
}
