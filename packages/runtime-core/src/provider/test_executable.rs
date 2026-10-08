use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    process::Command,
};

/// Build a finite owned test process instead of copying an Apple platform binary,
/// which can die before a process-identity or quiescence observation. Callers keep
/// their original duration arguments and exact child ownership/cleanup checks.
pub(super) fn sleeping_executable(binary: &Path) {
    assert!(!binary.try_exists().unwrap());
    let source = binary.with_extension("c");
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&source)
        .unwrap();
    file.write_all(
        b"#include <stdlib.h>\n#include <unistd.h>\n\
          int main(int argc, char **argv) {\n\
          if (argc != 2) return 2;\n\
          char *end = 0; unsigned long seconds = strtoul(argv[1], &end, 10);\n\
          if (*end || seconds == 0 || seconds > 120) return 2;\n\
          sleep((unsigned int)seconds); return 0;\n}\n",
    )
    .unwrap();
    drop(file);
    assert!(
        Command::new("cc")
            .args(["-std=c11", "-Wall", "-Wextra", "-Werror"])
            .arg(&source)
            .arg("-o")
            .arg(binary)
            .status()
            .unwrap()
            .success()
    );
    fs::set_permissions(binary, fs::Permissions::from_mode(0o700)).unwrap();
}
