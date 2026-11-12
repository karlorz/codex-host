use super::{process_identity, process_instance};

#[test]
fn process_instance_rejects_a_different_start_time() {
    let live = process_identity(std::process::id()).unwrap();
    assert_eq!(live.id, std::process::id());
    assert!(process_instance(live.id, live.started_at_micros).is_some());
    assert!(process_instance(live.id, live.started_at_micros + 1).is_none());
}

#[cfg(target_os = "linux")]
#[test]
fn an_unreaped_exited_process_is_not_a_running_instance() {
    use std::process::Command;
    use std::time::{Duration, Instant};
    use std::{fs, thread};

    let mut child = Command::new("/bin/sleep").arg("0.1").spawn().unwrap();
    let result = std::panic::catch_unwind(|| {
        let live = process_identity(child.id()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let stat = fs::read_to_string(format!("/proc/{}/stat", live.id)).unwrap();
            if stat[stat.rfind(')').unwrap() + 2..].starts_with("Z ") {
                break;
            }
            assert!(Instant::now() < deadline, "fixture did not exit");
            thread::sleep(Duration::from_millis(10));
        }
        assert!(process_instance(live.id, live.started_at_micros).is_none());
    });
    let _ = child.kill();
    child.wait().unwrap();
    result.unwrap();
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn identifies_and_signals_a_process_after_its_executable_is_replaced() {
    use crate::{process_snapshot, terminate_process_identity};
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};
    use std::{env, fs, thread};

    struct Fixture {
        child: Child,
        root: std::path::PathBuf,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    let root = env::temp_dir().join(format!(
        "codexhost-image-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(root.join("package")).unwrap();
    let executable = root.join("package/sleep");
    let source = root.join("sleep.c");
    fs::write(
        &source,
        "#include <unistd.h>\nint main(void) { for (;;) pause(); }\n",
    )
    .unwrap();
    assert!(
        Command::new("cc")
            .arg("-o")
            .arg(&executable)
            .arg(&source)
            .status()
            .unwrap()
            .success(),
        "cc failed to build the process-identity fixture"
    );
    let child = Command::new(&executable)
        .stdin(Stdio::null())
        .spawn()
        .unwrap();
    let mut fixture = Fixture { child, root };
    let deadline = Instant::now() + Duration::from_secs(5);
    let original = loop {
        if let Ok(snapshot) = process_snapshot(fixture.child.id())
            && snapshot.executable == executable.canonicalize().unwrap()
        {
            break snapshot;
        }
        assert!(Instant::now() < deadline, "fixture did not exec");
        assert!(
            fixture.child.try_wait().unwrap().is_none(),
            "fixture exited"
        );
        thread::sleep(Duration::from_millis(10));
    };
    let live = process_identity(fixture.child.id()).unwrap();
    // macOS SIGKILLs a still-loading image if the last directory entry is removed too early.
    thread::sleep(Duration::from_millis(200));
    assert!(
        fixture.child.try_wait().unwrap().is_none(),
        "fixture exited before replace"
    );

    fs::rename(
        fixture.root.join("package"),
        fixture.root.join("old-package"),
    )
    .unwrap();
    assert!(process_instance(live.id, live.started_at_micros).is_some());
    fs::remove_dir_all(fixture.root.join("old-package")).unwrap();
    assert!(process_instance(live.id, live.started_at_micros).is_some());
    #[cfg(target_os = "macos")]
    assert!(process_snapshot(live.id).is_err());
    #[cfg(target_os = "linux")]
    assert_ne!(
        process_snapshot(live.id).unwrap().executable,
        original.executable
    );
    fs::create_dir(fixture.root.join("package")).unwrap();
    fs::copy("/bin/sleep", &executable).unwrap();
    assert!(process_instance(live.id, live.started_at_micros).is_some());
    assert!(fixture.child.try_wait().unwrap().is_none());

    let reused = super::ProcessIdentity {
        started_at_micros: live.started_at_micros + 1,
        ..live
    };
    assert!(terminate_process_identity(&reused, true).is_err());
    assert!(fixture.child.try_wait().unwrap().is_none());
    // Exact signalling must not need the recorded image to remain on disk.
    terminate_process_identity(&live, true).unwrap();
    assert!(!fixture.child.wait().unwrap().success());
    assert!(process_instance(live.id, live.started_at_micros).is_none());
    assert_eq!(original.id, live.id);
}
