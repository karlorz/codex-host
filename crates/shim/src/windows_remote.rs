use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(test)]
use codexhost_platform::process_snapshot;
use codexhost_platform::{canonical_existing_file, terminate_process_instance};
use fs2::FileExt;
use serde::{Deserialize, Serialize};

use crate::{ShimResult, process_identity};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: u32,
    wrapper_path: PathBuf,
    stock_codex_path: PathBuf,
    node_path: PathBuf,
    shim_path: PathBuf,
    host_runtime_path: PathBuf,
    data_directory: PathBuf,
    shared_data_directory: Option<PathBuf>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Owner {
    pid: u32,
    started_at_micros: u64,
    shim_path: PathBuf,
    node_path: PathBuf,
    runtime_path: PathBuf,
}

impl Manifest {
    fn read(file: &Path) -> ShimResult<Self> {
        let manifest: Self = serde_json::from_slice(&fs::read(file)?)?;
        if manifest.format != 1
            || [
                &manifest.wrapper_path,
                &manifest.stock_codex_path,
                &manifest.node_path,
                &manifest.shim_path,
                &manifest.host_runtime_path,
                &manifest.data_directory,
            ]
            .iter()
            .any(|path| !path.is_absolute())
            || manifest
                .shared_data_directory
                .as_ref()
                .is_some_and(|path| !path.is_absolute())
        {
            return Err("Windows remote Host manifest has an unsupported format".into());
        }
        Ok(manifest)
    }

    fn command(&self) -> ShimResult<Command> {
        let mut command = Command::new(canonical_existing_file(&self.shim_path)?);
        command
            .env(
                "CODEXHOST_STOCK_CODEX_PATH",
                canonical_existing_file(&self.stock_codex_path)?,
            )
            .env(
                "CODEXHOST_HOST_NODE_PATH",
                canonical_existing_file(&self.node_path)?,
            )
            .env(
                "CODEXHOST_HOST_RUNTIME_PATH",
                canonical_existing_file(&self.host_runtime_path)?,
            )
            .env("CODEXHOST_DATA_DIR", &self.data_directory)
            .env("CODEXHOST_REMOTE_SSH_MANAGED", "1")
            .env("CODEXHOST_REMOTE_EXECUTION_SESSION", "ssh")
            .env(
                "CODEX_INSTALL_DIR",
                self.wrapper_path
                    .parent()
                    .ok_or("Managed Codex entrypoint has no directory")?,
            )
            .env_remove("CODEXHOST_LAUNCHER_PID")
            .env_remove("CODEXHOST_LAUNCHER_EXECUTABLE")
            .env_remove("CODEX_CLI_PATH");
        if let Some(home) = std::env::var_os("USERPROFILE") {
            command.env("HOME", home);
        }
        if let Some(shared) = &self.shared_data_directory {
            command.env("CODEXHOST_SHARED_DATA_DIR", shared);
        }
        Ok(command)
    }
}

fn owner_matches(owner: &Owner, manifest: &Manifest) -> ShimResult<bool> {
    Ok(
        owner.shim_path == canonical_existing_file(&manifest.shim_path)?
            && owner.node_path == canonical_existing_file(&manifest.node_path)?
            && owner.runtime_path == canonical_existing_file(&manifest.host_runtime_path)?,
    )
}

pub(super) fn is_listener(arguments: &[OsString]) -> bool {
    crate::should_start_host_runtime(arguments)
        && (arguments
            .windows(2)
            .any(|pair| pair[0] == "--listen" && pair[1] == "pipe://")
            || arguments
                .iter()
                .any(|argument| argument == "--listen=pipe://"))
}

pub(super) fn manage(arguments: &[OsString]) -> ShimResult<i32> {
    if arguments.len() != 2 {
        return Err("Windows remote lifecycle requires an action and manifest path".into());
    }
    let action = arguments[0]
        .to_str()
        .ok_or("Invalid Windows remote action")?;
    if action != "start" && action != "stop" {
        return Err("Windows remote action must be start or stop".into());
    }
    let file = Path::new(&arguments[1]);
    let manifest = Manifest::read(file)?;
    let root = file.parent().ok_or("Remote manifest has no directory")?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("windows-service.lock"))?;
    lock.try_lock_exclusive()
        .map_err(|_| "Another Windows remote lifecycle operation is active")?;
    let owner_file = root.join("windows-service.json");
    let owner = match fs::read(&owner_file) {
        Ok(bytes) => Some(serde_json::from_slice::<Owner>(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    if let Some(owner) = owner {
        if !owner_matches(&owner, &manifest)? {
            return Err("Windows remote service belongs to a different installation".into());
        }
        if let Some(snapshot) =
            process_identity::recorded_process_snapshot(owner.pid, owner.started_at_micros)?
        {
            if canonical_existing_file(&snapshot.executable)? != owner.shim_path {
                return Err(
                    "Windows remote service executable does not match its owner record".into(),
                );
            }
            if action == "start" {
                return Ok(0);
            }
            terminate_process_instance(&snapshot, true)?;
            let deadline = Instant::now() + Duration::from_secs(10);
            while process_identity::recorded_process_snapshot(owner.pid, owner.started_at_micros)?
                .is_some()
            {
                if Instant::now() >= deadline {
                    return Err("Windows remote supervisor did not stop".into());
                }
                thread::sleep(Duration::from_millis(25));
            }
        }
        fs::remove_file(&owner_file)?;
    }
    if action == "stop" {
        return Ok(0);
    }
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("runtime.log"))?;
    let mut command = manifest.command()?;
    command
        .args([
            "-c",
            "features.code_mode_host=true",
            "app-server",
            "--listen",
            "pipe://",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    // Break out of sshd's job; the long-lived Shim owns its own child Job Object.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        command.creation_flags(
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB,
        );
    }
    let mut child = command.spawn().map_err(|error| {
        format!("Could not detach Windows remote supervisor from the SSH session: {error}")
    })?;
    let record = (|| -> ShimResult<()> {
        let snapshot = process_identity::current_process_snapshot(child.id())?
            .ok_or("Windows remote supervisor exited before its identity was recorded")?;
        let owner = Owner {
            pid: snapshot.id,
            started_at_micros: snapshot.started_at_micros,
            shim_path: canonical_existing_file(&manifest.shim_path)?,
            node_path: canonical_existing_file(&manifest.node_path)?,
            runtime_path: canonical_existing_file(&manifest.host_runtime_path)?,
        };
        fs::write(&owner_file, serde_json::to_vec(&owner)?)?;
        Ok(())
    })();
    if let Err(error) = record {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok(0)
}

pub(super) fn bootstrap(arguments: &[OsString]) -> ShimResult<Option<i32>> {
    if std::env::var_os("CODEXHOST_REMOTE_SSH_MANAGED").is_some() {
        return Ok(None);
    }
    let current = std::env::current_exe()?;
    if current.file_name().and_then(|value| value.to_str()) != Some("codex.exe") {
        return Ok(None);
    }
    let file = current
        .parent()
        .and_then(Path::parent)
        .ok_or("Managed entrypoint has no root")?
        .join("manifest.json");
    if !file.is_file() {
        return Ok(None);
    }
    let manifest = Manifest::read(&file)?;
    if canonical_existing_file(&manifest.wrapper_path)? != canonical_existing_file(&current)? {
        return Err("Windows remote manifest points at a different entrypoint".into());
    }
    if is_listener(arguments) {
        return manage(&[OsString::from("start"), file.into_os_string()]).map(Some);
    }
    let status = manifest.command()?.args(arguments).status()?;
    Ok(Some(status.code().unwrap_or(1)))
}

pub(super) fn proxy(arguments: &[OsString]) -> ShimResult<Option<i32>> {
    if arguments.len() != 4
        || arguments[0] != "app-server"
        || arguments[1] != "proxy"
        || arguments[2] != "--sock"
    {
        return Ok(None);
    }
    let socket = arguments[3].to_str().ok_or("Invalid remote pipe path")?;
    if !socket.starts_with(r"\\.\pipe\codexhost-ssh-") {
        return Ok(None);
    }
    let pipe = OpenOptions::new().read(true).write(true).open(socket)?;
    let mut output = pipe.try_clone()?;
    thread::spawn(move || {
        let _ = crate::copy_stream(std::io::stdin().lock(), &mut output);
    });
    crate::copy_stream(pipe, std::io::stdout().lock())?;
    Ok(Some(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_actions_and_leaves_other_invocations_to_stock_codex() {
        assert!(is_listener(&[
            "app-server".into(),
            "--listen=pipe://".into()
        ]));
        assert!(is_listener(&[
            "app-server".into(),
            "--listen".into(),
            "pipe://".into()
        ]));
        assert!(!is_listener(&[
            "app-server".into(),
            "proxy".into(),
            "--sock".into(),
            "pipe://".into()
        ]));
        assert!(manage(&[]).is_err());
        assert!(manage(&["delete".into(), "missing".into()]).is_err());
        assert_eq!(bootstrap(&[]).unwrap(), None);
        assert_eq!(
            proxy(&[
                "app-server".into(),
                "proxy".into(),
                "--sock".into(),
                "/tmp/stock.sock".into()
            ])
            .unwrap(),
            None
        );
    }

    #[test]
    fn stop_does_not_terminate_a_reused_process_id_or_a_different_installation() {
        let root =
            std::env::temp_dir().join(format!("windows-remote-owner-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let current = std::env::current_exe().unwrap().canonicalize().unwrap();
        let runtime = root.join("runtime.mjs");
        fs::write(&runtime, "fixture").unwrap();
        let manifest_file = root.join("manifest.json");
        fs::write(
            &manifest_file,
            serde_json::to_vec(&serde_json::json!({
                "format": 1, "wrapperPath": current, "stockCodexPath": current,
                "nodePath": current, "shimPath": current, "hostRuntimePath": runtime,
                "dataDirectory": root
            }))
            .unwrap(),
        )
        .unwrap();
        let manifest = Manifest::read(&manifest_file).unwrap();
        let snapshot = process_snapshot(std::process::id()).unwrap();
        let mut owner = Owner {
            pid: snapshot.id,
            started_at_micros: snapshot.started_at_micros + 1,
            shim_path: current.clone(),
            node_path: current.clone(),
            runtime_path: runtime.canonicalize().unwrap(),
        };
        let owner_file = root.join("windows-service.json");
        fs::write(&owner_file, serde_json::to_vec(&owner).unwrap()).unwrap();
        assert_eq!(
            manage(&["stop".into(), manifest_file.clone().into_os_string()]).unwrap(),
            0
        );
        assert!(process_snapshot(snapshot.id).is_ok());
        assert!(!owner_file.exists());
        owner.runtime_path = current;
        assert!(!owner_matches(&owner, &manifest).unwrap());
        fs::write(&owner_file, serde_json::to_vec(&owner).unwrap()).unwrap();
        assert!(
            manage(&["stop".into(), manifest_file.into_os_string()])
                .unwrap_err()
                .to_string()
                .contains("different installation")
        );
        assert!(owner_file.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
