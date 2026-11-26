#![cfg(target_os = "windows")]

use std::fs::{self, OpenOptions};
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

fn wait_for(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !predicate() {
        assert!(
            Instant::now() < deadline,
            "Windows remote service did not reach the expected state"
        );
        thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn detached_windows_supervisor_survives_start_and_stops_its_runtime_job() {
    let directory = std::env::temp_dir().join(format!("cx-remote-native-{}", std::process::id()));
    fs::create_dir_all(&directory).unwrap();
    let shim = Path::new(env!("CARGO_BIN_EXE_codexhost-shim"))
        .canonicalize()
        .unwrap();
    let output = Command::new("where.exe").arg("node.exe").output().unwrap();
    assert!(
        output.status.success(),
        "Node is required for the Windows native test"
    );
    let node = std::path::PathBuf::from(
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .canonicalize()
    .unwrap();
    let runtime = directory.join("fixture.mjs");
    let ready = directory.join("ready.json");
    let pipe = format!(r"\\.\pipe\codexhost-ssh-test-{}", std::process::id());
    fs::write(&runtime, format!(
        "import net from 'node:net'; import fs from 'node:fs'; import {{spawn}} from 'node:child_process'; const child = spawn(process.execPath, ['-e', 'setInterval(() => {{}}, 1000)'], {{stdio:'ignore'}}); net.createServer(socket => socket.end()).listen({}, () => fs.writeFileSync({}, JSON.stringify({{pid:process.pid, childPid:child.pid}})));",
        serde_json::to_string(&pipe).unwrap(), serde_json::to_string(&ready).unwrap()
    )).unwrap();
    let manifest = directory.join("manifest.json");
    fs::write(
        &manifest,
        serde_json::to_vec(&serde_json::json!({
            "format": 1, "wrapperPath": directory.join("codex.exe"), "stockCodexPath": node,
            "nodePath": node, "shimPath": shim, "hostRuntimePath": runtime,
            "dataDirectory": directory.join("data")
        }))
        .unwrap(),
    )
    .unwrap();
    let start = Command::new(&shim)
        .args(["--codexhost-windows-remote", "start"])
        .arg(&manifest)
        .output()
        .unwrap();
    assert!(
        start.status.success(),
        "{}",
        String::from_utf8_lossy(&start.stderr)
    );
    let stopped = || {
        Command::new(&shim)
            .args(["--codexhost-windows-remote", "stop"])
            .arg(&manifest)
            .output()
            .unwrap()
    };
    let result = std::panic::catch_unwind(|| {
        wait_for(|| ready.is_file());
        let ready_record =
            serde_json::from_slice::<serde_json::Value>(&fs::read(&ready).unwrap()).unwrap();
        let pid = ready_record["pid"].as_u64().unwrap() as u32;
        let child_pid = ready_record["childPid"].as_u64().unwrap() as u32;
        assert!(
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&pipe)
                .is_ok()
        );
        let second = Command::new(&shim)
            .args(["--codexhost-windows-remote", "start"])
            .arg(&manifest)
            .output()
            .unwrap();
        assert!(second.status.success());
        let stop = stopped();
        assert!(
            stop.status.success(),
            "{}",
            String::from_utf8_lossy(&stop.stderr)
        );
        wait_for(|| codexhost_platform::process_snapshot(pid).is_err());
        wait_for(|| codexhost_platform::process_snapshot(child_pid).is_err());
        assert!(
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&pipe)
                .is_err()
        );
        assert!(stopped().status.success());
    });
    let _ = stopped();
    fs::remove_dir_all(directory).unwrap();
    if let Err(error) = result {
        std::panic::resume_unwind(error);
    }
}
