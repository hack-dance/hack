# Native startup lock contention

The stopped-pool startup model still covers effect-time lease acquisition
and retained identity verification. This model covers contention at that
acquisition boundary for a provider or image-cache lock. The shared
`state::wait_for_acquisition` loop retries acquisition without executing
the protected operation. A successful lock passes control to the caller's
existing verification and effect. An exhausted wait returns the last
observed contention refusal.

Two contenders use one lock. One can release, one waits across at most
five abstract ticks. Weak fairness assumes the waiting process can keep
taking attempts and the clock eventually advances. Release during the
budget permits acquisition; expiry never gives the waiter authority. The
negative control admits a waiter while the lock is held. The model
abstracts scheduling latency, cross-lock ordering, filesystem failures
and holder-record durability.

TLC explores 19 states. Separate reachability controls show `Acquire`
after a release and `Expire` at the fifth tick. The Rust regression waits
on an actual flock, then either acquires after release or preserves the
holder diagnostic on expiry. [State chart](lease-wait.svg).
