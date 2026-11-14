//! Standalone lifecycle owner; no terminal, shell wrapper, or environment file.
//!
//! Transition table (specified before implementation):
//! | From | Guard / action | To | Durable consequence |
//! | absent | command lock acquired, record guard identity | starting | identity before execution |
//! | starting | authored spawn succeeds | running | command PID, no environment |
//! | starting | authored spawn fails | exited | no authored process |
//! | running | verified owner requests TERM | stopping | retained ownership |
//! | stopping | no live authored session members | exited | retained terminal receipt |
//! | stopping | five-second grace expires | kill-pending | KILL authored session groups |
//! | kill-pending | no live authored session members | killed | confirmed terminal receipt |
//! | kill-pending | live members remain | kill-pending | retain guard and lock; stop unknown |
//! | starting/running | project owner dies | same | resident guard retains lock and identity |
//! | any live | duplicate command / lock busy | refused | no second execution |
//! | any | token or identity mismatch | refused | no signal |
//! | any | guard dead and authored session live | orphaned | duplicate and stop refused |
//!
//! A resident guard is the session leader in its own process group. Authored
//! commands receive a different group in that session. It publishes its kernel
//! identity before starting authored code, and remains present while any live
//! session member remains. A project-owner crash therefore leaves a verifiable
//! leader. Killing that guard separately is an unknown-ownership outcome and
//! fails closed when a live group remains.

mod incremental;
mod os;
mod protocol;
mod storage;
mod supervisor;

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("hack-lifecycle-supervisor 0.1.0 protocol=1 incremental=1");
        return;
    }
    if supervisor::main().is_err() {
        // Inputs can contain credentials. Never include parser or OS error text.
        eprintln!("Lifecycle supervisor refused or failed; values omitted.");
        std::process::exit(1);
    }
}

type Result<T> = std::result::Result<T, std::io::Error>;

fn refused() -> std::io::Error {
    std::io::Error::other("Lifecycle operation refused; values omitted")
}
