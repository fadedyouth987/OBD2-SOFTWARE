//! `edge-daemon pair` (Task 5.1): writes only the pairing folder, never the
//! service's log file, and says which data folder it used.

use std::process::Command;

#[test]
fn pair_writes_only_the_pairing_folder_and_names_it() {
    let dir = std::env::temp_dir().join(format!("edge-cli-pair-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let out = Command::new(env!("CARGO_BIN_EXE_edge-daemon"))
        .arg("pair")
        .env("EDGE_DATA_DIR", &dir)
        .output()
        .expect("runs");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "{stdout}{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let code = stdout
        .lines()
        .find_map(|l| l.strip_prefix("Pairing code: "))
        .expect("prints a code");
    assert!(
        code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit()),
        "{code}"
    );
    assert!(
        stdout.contains(&dir.display().to_string()),
        "names the data folder: {stdout}"
    );
    assert!(dir.join("pairing").join("pairing.json").is_file());
    // A technician's `pair` never opens (or rotates) the service's log file.
    assert!(!dir.join("logs").exists(), "pair created the log folder");
    std::fs::remove_dir_all(&dir).unwrap();
}
