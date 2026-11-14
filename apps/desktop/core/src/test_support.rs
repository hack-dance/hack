//! Publish executable fixtures only after their writer is closed.
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::Path;

pub fn script(path: &Path, body: impl AsRef<[u8]>) {
    let pending = path.with_extension("pending");
    let mut writer = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&pending)
        .unwrap();
    writer.write_all(body.as_ref()).unwrap();
    writer.sync_all().unwrap();
    drop(writer);
    std::fs::set_permissions(&pending, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::rename(pending, path).unwrap();
}
