//! Private, bounded file capture using the shared span serializer.
use super::{LINE_LIMIT, RECORD_LIMIT, Sink};
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
use std::path::Path;
use std::sync::Mutex;

pub(super) struct FileSink {
    file: Mutex<File>,
    queued: Mutex<Vec<Vec<u8>>>,
}
impl FileSink {
    pub(super) fn open(path: &Path) -> Option<Self> {
        if !path.is_absolute() {
            return None;
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(path)
            .ok()?;
        if !file.metadata().ok()?.is_file() {
            return None;
        }
        Some(Self {
            file: Mutex::new(file),
            queued: Mutex::new(Vec::new()),
        })
    }
}
impl Sink for FileSink {
    fn atomic_limit(&self) -> usize {
        LINE_LIMIT
    }
    fn write_line(&self, line: &[u8]) -> bool {
        let Ok(mut queue) = self.queued.try_lock() else {
            return false;
        };
        if queue.len() >= RECORD_LIMIT || line.len() > LINE_LIMIT {
            return false;
        }
        queue.push(line.to_vec());
        true
    }
    fn flush(&self) {
        let Ok(mut file) = self.file.try_lock() else {
            return;
        };
        let Ok(mut queue) = self.queued.try_lock() else {
            return;
        };
        // SAFETY: the owned regular-file descriptor remains live through unlock.
        // Only explicit flushes take the append lock; hot-path writes only queue.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return;
        }
        let mut written = 0;
        for line in queue.iter() {
            if file.write_all(line).is_err() {
                break;
            }
            written += 1;
        }
        queue.drain(..written);
        // SAFETY: unlock the same live descriptor acquired above.
        unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_sink_rejects_symlinks_and_bounds_whole_queued_lines() {
        let root = std::env::temp_dir().join(format!("engine-timing-sink-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("capture.jsonl");
        let link = root.join("link");
        let sink = FileSink::open(&path).unwrap();
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(FileSink::open(&link).is_none());
        assert!(FileSink::open(&root).is_none());
        assert!(FileSink::open(Path::new("relative.jsonl")).is_none());
        for _ in 0..RECORD_LIMIT {
            assert!(sink.write_line(b"{}\n"));
        }
        assert!(!sink.write_line(b"{}\n"));
        assert!(std::fs::read(&path).unwrap().is_empty());
        sink.flush();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap().lines().count(),
            RECORD_LIMIT
        );
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
