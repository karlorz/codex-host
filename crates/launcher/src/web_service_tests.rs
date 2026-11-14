use super::{Options, ReadyOwner, WebAccess, command_line_matches_web};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{env, fs, thread};

#[test]
fn command_line_matches_web_requires_runtime_and_data() {
    let runtime = Path::new("/Applications/codexhost.app/Contents/Resources/app/web-server.mjs");
    let data = Path::new("/Users/karlchow/.codexhost");
    assert!(command_line_matches_web(
        "/runtime/node --disable-warning=UNDICI-EHPA /Applications/codexhost.app/Contents/Resources/app/web-server.mjs --background --ready-file /Users/karlchow/.codexhost/web-service-node-ready.json --ch-data /Users/karlchow/.codexhost --ch-launcher /Applications/codexhost.app/Contents/MacOS/codexhost",
        runtime,
        data,
    ));
    assert!(command_line_matches_web(
        "/runtime/node /Applications/codexhost.app/Contents/Resources/app/web-server.mjs --background --ch-data=/Users/karlchow/.codexhost",
        runtime,
        data,
    ));
    assert!(command_line_matches_web(
        r#"/runtime/node "/Applications/codexhost.app/Contents/Resources/app/web-server.mjs" --background --ch-data "/Users/karl chow/.codexhost""#,
        runtime,
        Path::new("/Users/karl chow/.codexhost"),
    ));
    assert!(!command_line_matches_web(
        "/runtime/node /Applications/codexhost.app/Contents/Resources/app/web-server.mjs --ch-data=/Users/karlchow/.codexhost",
        runtime,
        data,
    ));
    assert!(!command_line_matches_web(
        "/runtime/node /Applications/codexhost.app/Contents/Resources/app/web-server.mjs.bak --background --ch-data /Users/karlchow/.codexhost",
        runtime,
        data,
    ));
    assert!(!command_line_matches_web(
        "/runtime/node /Applications/codexhost.app/Contents/Resources/app/web-server.mjs --background --ch-data /tmp/other",
        runtime,
        data,
    ));
    assert!(!command_line_matches_web(
        "/runtime/node /checkout/packages/web-server/dist/app/server.mjs --background --ch-data /Users/karlchow/.codexhost --port 4400",
        runtime,
        data,
    ));
    assert!(!command_line_matches_web(
        "/runtime/node --background --ch-data /Users/karlchow/.codexhost",
        runtime,
        data,
    ));
}

#[test]
fn stop_waits_for_the_recorded_instance_without_its_original_image() {
    const TEST: &str =
        "web_service::tests::stop_waits_for_the_recorded_instance_without_its_original_image";
    if let Some(root) = env::var_os("CODEXHOST_WEB_STOP_TEST") {
        let root = std::path::PathBuf::from(root);
        fs::write(root.join("started"), "ready").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !root.join("web-service.stop").exists() {
            assert!(Instant::now() < deadline, "stop request not received");
            thread::sleep(Duration::from_millis(10));
        }
        thread::sleep(Duration::from_millis(200));
        return;
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = env::temp_dir().join(format!("codexhost-web-stop-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let executable = env::current_exe().unwrap();
    let mut child = Command::new(&executable)
        .args(["--exact", TEST])
        .env("CODEXHOST_WEB_STOP_TEST", &root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !root.join("started").exists() {
            assert!(Instant::now() < deadline, "fixture did not start");
            thread::sleep(Duration::from_millis(10));
        }
        let live = codexhost_platform::process_identity(child.id()).unwrap();
        let record = ReadyOwner {
            pid: live.id,
            started_at_micros: live.started_at_micros,
            executable: root.join("deleted-package/codexhost"),
            web_pid: live.id,
            version: "0.18.0-beta.4".into(),
            runtime: root.join("web-server.mjs"),
            access: WebAccess {
                address: "http://127.0.0.1:4400/".into(),
                login_url: String::new(),
            },
        };
        let file = root.join(super::READY);
        fs::write(&file, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(super::owner(&root).unwrap().is_some());
        let mut reused = record;
        reused.started_at_micros += 1;
        fs::write(&file, serde_json::to_vec(&reused).unwrap()).unwrap();
        assert!(super::owner(&root).unwrap().is_none());
        reused.started_at_micros -= 1;
        fs::write(&file, serde_json::to_vec(&reused).unwrap()).unwrap();
        let options = Options {
            node: executable.clone(),
            host_node: executable.clone(),
            runtime: executable.clone(),
            host_runtime: executable.clone(),
            data: root.clone(),
            ready: None,
        };
        assert!(super::stop(&options).unwrap());
        assert!(
            child.try_wait().unwrap().is_some(),
            "stop returned before exit"
        );
    }));
    if result.is_err() {
        let _ = child.kill();
    }
    let status = child.wait().unwrap();
    fs::remove_dir_all(&root).unwrap();
    result.unwrap();
    assert!(status.success());
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn node_executable() -> std::path::PathBuf {
    let output = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .unwrap();
    assert!(output.status.success());
    std::path::PathBuf::from(String::from_utf8(output.stdout).unwrap().trim())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn stop_orphaned_web_leaves_node_with_a_live_parent() {
    let node = node_executable();
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = env::temp_dir().join(format!(
        "codexhost-web-live-parent-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let runtime = root.join("web-server.mjs");
    fs::write(&runtime, "setInterval(() => {}, 1000);\n").unwrap();
    let mut child = Command::new(&node)
        .arg(&runtime)
        .arg("--background")
        .arg("--ch-data")
        .arg(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let options = Options {
        node: node.clone(),
        host_node: node,
        runtime: runtime.clone(),
        host_runtime: runtime,
        data: root.clone(),
        ready: None,
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        assert!(!super::stop_orphaned_web(&options).unwrap());
        assert!(
            child.try_wait().unwrap().is_none(),
            "supervised Node was terminated"
        );
    }));
    let _ = child.kill();
    let _ = child.wait();
    fs::remove_dir_all(&root).unwrap();
    result.unwrap();
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn stop_orphaned_web_terminates_node_after_its_parent_exits() {
    const TEST: &str =
        "web_service::tests::stop_orphaned_web_terminates_node_after_its_parent_exits";
    if let Some(root) = env::var_os("CODEXHOST_WEB_ORPHAN_TEST") {
        let root = std::path::PathBuf::from(root);
        let node = env::var("CODEXHOST_WEB_ORPHAN_NODE").expect("orphan Node path");
        let runtime = root.join("web-server.mjs");
        let child = Command::new(node)
            .arg(&runtime)
            .arg("--background")
            .arg("--ch-data")
            .arg(&root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        fs::write(root.join("pid"), child.id().to_string()).unwrap();
        std::process::exit(0);
    }
    let node = node_executable();
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = env::temp_dir().join(format!(
        "codexhost-web-orphan-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&root).unwrap();
    let runtime = root.join("web-server.mjs");
    fs::write(&runtime, "setInterval(() => {}, 1000);\n").unwrap();
    let status = Command::new(env::current_exe().unwrap())
        .args(["--exact", TEST])
        .env("CODEXHOST_WEB_ORPHAN_TEST", &root)
        .env("CODEXHOST_WEB_ORPHAN_NODE", &node)
        .status()
        .unwrap();
    assert!(status.success(), "orphan helper failed");
    let pid: u32 = fs::read_to_string(root.join("pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if let Ok(live) = codexhost_platform::process_identity(pid)
            && live.parent_id <= 1
        {
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    let options = Options {
        node: node.clone(),
        host_node: node,
        runtime: runtime.clone(),
        host_runtime: runtime,
        data: root.clone(),
        ready: None,
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        assert!(super::stop_orphaned_web(&options).unwrap());
        assert!(
            codexhost_platform::process_snapshot(pid).is_err(),
            "orphaned Node survived stop"
        );
    }));
    if let Ok(live) = codexhost_platform::process_identity(pid) {
        let _ = Command::new("kill")
            .args(["-KILL", &live.id.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    fs::remove_dir_all(&root).unwrap();
    result.unwrap();
}
