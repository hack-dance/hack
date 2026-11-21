//! HACK-2460: one runtime service per native home. The design model is
//! `tests/models/tla/runtime-service`. This slice adds only the frame layer the
//! service and its clients share; nothing serves or calls it yet.
pub mod frame;

pub use frame::CONTROL_FRAME_LIMIT;
