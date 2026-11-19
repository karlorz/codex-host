#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::collections::{HashMap, HashSet};
use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::io::{self, BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use codexhost_platform::{
    DesktopInstallation, PlatformError, ProcessSnapshot, descendant_executable_pair_exists,
    desktop_root_process_ids_for_installation, process_snapshot, terminate_process_instance,
};
#[cfg(target_os = "windows")]
use codexhost_platform::{process_executable_path, process_exists, terminate_process_by_id};

use crate::ResolvedLaunchOptions;
use crate::runtime_instance::{
    LauncherGuard, RuntimeDescriptor, RuntimeDescriptorGuard, default_descriptor_path,
    default_guard_path, random_nonce, read_descriptor, remove_matching_descriptor,
    try_acquire_launcher_guard,
};

const ATTACHMENT_RETRY_INITIAL_DELAY: Duration = Duration::from_millis(100);
const ATTACHMENT_RETRY_MAX_DELAY: Duration = Duration::from_secs(1);
const ORPHANED_CONTROLLER_STOP_GRACE: Duration = Duration::from_secs(2);
#[cfg(target_os = "windows")]
const HOST_CHAIN_READY_TIMEOUT: Duration = Duration::from_secs(90);
#[cfg(not(target_os = "windows"))]
const HOST_CHAIN_READY_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub(super) struct RuntimeControl {
    pub(super) renderer_cdp_endpoint: String,
    pub(super) renderer_cdp_arguments: [OsString; 2],
    pub(super) attachment_port: u16,
    pub(super) nonce: String,
}

pub(super) fn allocate_runtime_control() -> Result<RuntimeControl, Box<dyn Error>> {
    let renderer_cdp = TcpListener::bind(("127.0.0.1", 0))?;
    let attachment = TcpListener::bind(("127.0.0.1", 0))?;
    let renderer_cdp_port = renderer_cdp.local_addr()?.port();
    let attachment_port = attachment.local_addr()?.port();
    drop(attachment);
    drop(renderer_cdp);
    Ok(RuntimeControl {
        renderer_cdp_endpoint: format!("http://127.0.0.1:{renderer_cdp_port}"),
        renderer_cdp_arguments: [
            OsString::from("--remote-debugging-address=127.0.0.1"),
            OsString::from(format!("--remote-debugging-port={renderer_cdp_port}")),
        ],
        attachment_port,
        nonce: random_nonce()?,
    })
}

pub(super) enum LauncherOwnership {
    Acquired(LauncherGuard),
    Attached,
}

pub(super) fn acquire_launcher_ownership(
    installation: &DesktopInstallation,
    timeout: Duration,
) -> Result<LauncherOwnership, Box<dyn Error>> {
    let guard_path = default_guard_path()?;
    if let Some(guard) = try_acquire_launcher_guard(&guard_path)? {
        return Ok(LauncherOwnership::Acquired(guard));
    }

    let descriptor_path = default_descriptor_path()?;
    let started = Instant::now();
    let mut retry_delay = ATTACHMENT_RETRY_INITIAL_DELAY;
    while started.elapsed() < timeout {
        let descriptor = read_descriptor(&descriptor_path).ok().flatten();
        if let Some(descriptor) = &descriptor {
            if try_activate_controlled_instance(descriptor)? {
                return Ok(LauncherOwnership::Attached);
            }
            if desktop_root_process_ids_for_installation(installation)?.is_empty() {
                recover_stale_controller(descriptor, &descriptor_path)?;
            }
        }
        if let Some(guard) = try_acquire_launcher_guard(&guard_path)? {
            return Ok(LauncherOwnership::Acquired(guard));
        }
        // A recovering Controller reports busy while one attachment owns the
        // recovery work. Back off retries so another Launcher cannot create a
        // connection storm while the healthy owner keeps its guard.
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            break;
        }
        thread::sleep(retry_delay.min(remaining));
        retry_delay = retry_delay
            .saturating_mul(2)
            .min(ATTACHMENT_RETRY_MAX_DELAY);
    }
    Err("another codexhost Launcher did not become attachable before timeout".into())
}

pub(super) fn endpoint_ready(port: u16, timeout: Duration) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .expect("valid loopback socket address"),
        timeout,
    )
    .is_ok()
}

pub(super) fn host_chain_ready_timeout() -> Duration {
    HOST_CHAIN_READY_TIMEOUT
}

/// Wait until Shim and bundled Node appear under the launched Desktop process.
///
/// Readiness stays on that verified process. Another live Desktop root is not
/// adopted for Host-chain lookup, supervision, or cleanup.
pub(super) fn wait_for_host_chain(
    desktop: &ProcessSnapshot,
    options: &ResolvedLaunchOptions,
    timeout: Duration,
) -> Result<bool, Box<dyn Error>> {
    let nodes =
        host_runtime_node_candidates(options.node.clone(), env::var_os(crate::NPM_NODE_PATH_ENV));
    wait_for_host_chain_with_nodes(desktop, options, &nodes, timeout)
}

/// The Shim runs the Host Runtime on the Node selected at launch
/// (`options.node`, the Desktop cua_node in installer layouts) — but on
/// npm-managed installs it overrides the Host Runtime to
/// `CODEXHOST_NPM_NODE_PATH` (the npm wrapper's `process.execPath`). Readiness
/// must accept that Node too, or the wait blocks on a late, unrelated Desktop
/// `cua_node` helper instead of the actual Host Runtime process.
pub(super) fn host_runtime_node_candidates(
    default_node: PathBuf,
    npm_node: Option<OsString>,
) -> Vec<PathBuf> {
    let mut nodes = vec![default_node];
    if let Some(npm_node) = npm_node
        .map(PathBuf::from)
        .filter(|node| node.is_file() && !nodes.contains(node))
    {
        nodes.push(npm_node);
    }
    nodes
}

pub(super) fn wait_for_host_chain_with_nodes(
    desktop: &ProcessSnapshot,
    options: &ResolvedLaunchOptions,
    nodes: &[PathBuf],
    timeout: Duration,
) -> Result<bool, Box<dyn Error>> {
    wait_for_host_chain_with_inspector(desktop, &options.shim, nodes, timeout, |node| {
        descendant_executable_pair_exists(desktop, &options.shim, node)
    })
}

fn wait_for_host_chain_with_inspector(
    desktop: &ProcessSnapshot,
    shim: &Path,
    nodes: &[PathBuf],
    timeout: Duration,
    mut inspect: impl FnMut(&Path) -> Result<bool, PlatformError>,
) -> Result<bool, Box<dyn Error>> {
    let started = Instant::now();
    // `unresolved_error` belongs to the latest round that could not inspect
    // every candidate and alone decides whether a timeout is an error. A later
    // round that inspects every candidate without a match proves the tree was
    // observable, so the timeout then takes the caller's normal cleanup path.
    // `last_error` outlives such rounds and only feeds the diagnostic.
    let mut unresolved_error = None;
    let mut last_error = None;
    while started.elapsed() < timeout {
        let mut round_error = None;
        for node in nodes {
            match inspect(node) {
                Ok(true) => return Ok(true),
                Ok(false) => {}
                Err(error) => round_error = Some(error.to_string()),
            }
        }
        if round_error.is_some() {
            last_error = round_error.clone();
        }
        unresolved_error = round_error;
        thread::sleep(Duration::from_millis(100));
    }
    // Without evidence the timeout is indistinguishable from a broken Desktop
    // launch, a stalled Controller, or an unobservable process tree (#882).
    // Record what the wait was matching against and what was last observed so
    // the next report can pin the failing stage.
    crate::startup_trace(&host_chain_timeout_diagnostic(
        desktop,
        shim,
        nodes,
        last_error.as_deref(),
    ));
    if let Some(error) = unresolved_error {
        return Err(error.into());
    }
    Ok(false)
}

/// One-shot diagnostic snapshot taken when the Host chain wait times out.
fn host_chain_timeout_diagnostic(
    desktop: &ProcessSnapshot,
    shim: &Path,
    nodes: &[PathBuf],
    last_error: Option<&str>,
) -> String {
    let nodes_display = nodes
        .iter()
        .map(|node| node.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let mut diagnostic = format!(
        "Host chain wait timed out: Desktop root pid {} ({}), expected shim '{}' and node candidates [{}]",
        desktop.id,
        desktop.executable.display(),
        shim.display(),
        nodes_display,
    );
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    match codexhost_platform::process_snapshots() {
        Ok(snapshots) => match snapshots_in_desktop_tree(desktop, &snapshots) {
            Some(tree) => {
                let shim_running = tree.iter().any(|process| process.executable == shim);
                let node_running = tree
                    .iter()
                    .any(|process| nodes.iter().any(|node| &process.executable == node));
                diagnostic = format!(
                    "{diagnostic}; {} live processes observed, {} in this Desktop tree, shim running in this Desktop tree: {shim_running}, node running in this Desktop tree: {node_running}",
                    snapshots.len(),
                    tree.len()
                );
            }
            None => {
                diagnostic = format!(
                    "{diagnostic}; {} live processes observed, original Desktop instance is not visible",
                    snapshots.len()
                );
            }
        },
        Err(error) => {
            diagnostic = format!("{diagnostic}; live process enumeration failed: {error}");
        }
    }
    if let Some(error) = last_error {
        diagnostic = format!("{diagnostic}; last process-tree inspection error: {error}");
    }
    diagnostic
}

/// The original Desktop instance and its descendants. A process instance is a
/// PID plus its start time, so a recycled PID is not mistaken for the Desktop;
/// `None` means that instance is no longer alive.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn snapshots_in_desktop_tree<'a>(
    desktop: &ProcessSnapshot,
    snapshots: &'a [ProcessSnapshot],
) -> Option<Vec<&'a ProcessSnapshot>> {
    let root = snapshots.iter().find(|process| {
        process.id == desktop.id && process.started_at_micros == desktop.started_at_micros
    })?;
    let mut children: HashMap<u32, Vec<&ProcessSnapshot>> = HashMap::new();
    for process in snapshots {
        children.entry(process.parent_id).or_default().push(process);
    }
    let mut visited = HashSet::from([root.id]);
    let mut tree = vec![root];
    let mut pending = vec![root.id];
    while let Some(parent_id) = pending.pop() {
        for &child in children.get(&parent_id).into_iter().flatten() {
            if visited.insert(child.id) {
                tree.push(child);
                pending.push(child.id);
            }
        }
    }
    Some(tree)
}

pub(super) fn publish_runtime_descriptor(
    descriptor_path: &Path,
    control: &RuntimeControl,
) -> Result<RuntimeDescriptorGuard, Box<dyn Error>> {
    let descriptor = RuntimeDescriptor::new(
        std::process::id(),
        control.attachment_port,
        control.nonce.clone(),
    )?;
    Ok(RuntimeDescriptorGuard::publish(
        descriptor_path.to_path_buf(),
        descriptor,
    )?)
}

fn connect_controlled_instance(descriptor: &RuntimeDescriptor) -> std::io::Result<TcpStream> {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", descriptor.control_port)
            .parse()
            .expect("valid loopback socket address"),
        Duration::from_secs(2),
    )
}

fn send_controlled_attachment(
    stream: TcpStream,
    descriptor: &RuntimeDescriptor,
) -> Result<bool, Box<dyn Error>> {
    send_controlled_attachment_with_timeout(stream, descriptor, Duration::from_secs(10))
}

fn send_controlled_attachment_with_timeout(
    mut stream: TcpStream,
    descriptor: &RuntimeDescriptor,
    read_timeout: Duration,
) -> Result<bool, Box<dyn Error>> {
    stream.set_read_timeout(Some(read_timeout))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    writeln!(stream, "ATTACH {}", descriptor.nonce)?;
    let mut response = String::new();
    match BufReader::new(stream).read_line(&mut response) {
        Ok(_) => {}
        // An orderly Controller close is an empty response, but Winsock may surface the same
        // close as WSAECONNRESET. Both mean the controlled Desktop is not attachable yet.
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::ConnectionAborted
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::TimedOut
                    | io::ErrorKind::WouldBlock
            ) =>
        {
            return Ok(false);
        }
        Err(error) => return Err(error.into()),
    }
    match response.trim_end() {
        "ready" => Ok(true),
        "busy" => Ok(false),
        "rejected" => Err("Desktop Controller rejected the attachment nonce".into()),
        "failed" => Err("Desktop Controller could not restore the running Desktop".into()),
        // An empty or malformed status can come from a Controller that is still
        // restoring the Desktop. Treat it as transient rather than abandoning
        // the healthy Launcher that still owns the runtime guard.
        _ => Ok(false),
    }
}

pub(super) fn try_activate_controlled_instance(
    descriptor: &RuntimeDescriptor,
) -> Result<bool, Box<dyn Error>> {
    let stream = match connect_controlled_instance(descriptor) {
        Ok(stream) => stream,
        Err(_) => return Ok(false),
    };
    send_controlled_attachment(stream, descriptor)
}

#[cfg(target_os = "windows")]
pub(super) fn stop_stale_launcher(descriptor: &RuntimeDescriptor) -> Result<(), Box<dyn Error>> {
    if descriptor.launcher_pid == std::process::id() || !process_exists(descriptor.launcher_pid) {
        return Ok(());
    }
    let expected = env::current_exe()?.canonicalize()?;
    if !recorded_launcher_is_current(process_executable_path(descriptor.launcher_pid), &expected) {
        return Ok(());
    }
    terminate_process_by_id(descriptor.launcher_pid)?;
    let started = Instant::now();
    while process_exists(descriptor.launcher_pid) && started.elapsed() < Duration::from_secs(2) {
        thread::sleep(Duration::from_millis(20));
    }
    if process_exists(descriptor.launcher_pid) {
        return Err(format!(
            "stale codexhost launcher PID {} did not exit before timeout",
            descriptor.launcher_pid
        )
        .into());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(super) fn stop_stale_launcher(_descriptor: &RuntimeDescriptor) -> Result<(), Box<dyn Error>> {
    Ok(())
}

/// Stop a Desktop Controller that outlived its Launcher and Desktop.
///
/// A failed or interrupted `npm start` can kill Desktop while leaving the
/// Controller listening on the recorded attachment port. The next launch then
/// owns the Launcher lock with no Desktop. Only a listener whose command line
/// still carries this descriptor's attachment port and nonce is ours to stop.
pub(super) fn recover_stale_controller(
    descriptor: &RuntimeDescriptor,
    descriptor_path: &Path,
) -> Result<(), Box<dyn Error>> {
    stop_orphaned_controller(descriptor)?;
    stop_stale_launcher(descriptor)?;
    let _ = remove_matching_descriptor(descriptor_path, descriptor)?;
    Ok(())
}

pub(super) fn stop_orphaned_controller(
    descriptor: &RuntimeDescriptor,
) -> Result<(), Box<dyn Error>> {
    let matches = matching_controller_process_ids(descriptor)?;
    if matches.is_empty() {
        return Ok(());
    }
    for process_id in &matches {
        terminate_controller_process(*process_id, false)?;
    }
    if wait_for_controller_exit(descriptor, ORPHANED_CONTROLLER_STOP_GRACE)? {
        return Ok(());
    }
    for process_id in matching_controller_process_ids(descriptor)? {
        terminate_controller_process(process_id, true)?;
    }
    if wait_for_controller_exit(descriptor, ORPHANED_CONTROLLER_STOP_GRACE)? {
        return Ok(());
    }
    Err(format!(
        "leftover Desktop Controller on port {} did not exit before timeout",
        descriptor.control_port
    )
    .into())
}

fn command_line_matches_controller(command: &str, descriptor: &RuntimeDescriptor) -> bool {
    let port = descriptor.control_port.to_string();
    let mut saw_port = false;
    let mut saw_nonce = false;
    let mut arguments = command.split_whitespace();
    while let Some(argument) = arguments.next() {
        match argument {
            "--attachment-port" => {
                saw_port |= arguments.next() == Some(port.as_str());
            }
            "--attachment-nonce" => {
                saw_nonce |= arguments.next() == Some(descriptor.nonce.as_str());
            }
            _ => {}
        }
    }
    saw_port && saw_nonce
}

pub(super) fn matching_controller_process_ids(
    descriptor: &RuntimeDescriptor,
) -> Result<Vec<u32>, Box<dyn Error>> {
    let mut matches = Vec::new();
    for (process_id, command) in process_command_lines()? {
        if process_id == std::process::id() {
            continue;
        }
        if command_line_matches_controller(&command, descriptor) {
            matches.push(process_id);
        }
    }
    Ok(matches)
}

fn terminate_controller_process(process_id: u32, force: bool) -> Result<(), Box<dyn Error>> {
    if process_id == std::process::id() {
        return Ok(());
    }
    match process_snapshot(process_id) {
        Ok(snapshot) => {
            terminate_process_instance(&snapshot, force)?;
            Ok(())
        }
        Err(_) => Ok(()),
    }
}

pub(super) fn wait_for_controller_exit(
    descriptor: &RuntimeDescriptor,
    timeout: Duration,
) -> Result<bool, Box<dyn Error>> {
    wait_for_known_controller_exit(descriptor, &[], timeout)
}

pub(super) fn wait_for_known_controller_exit(
    descriptor: &RuntimeDescriptor,
    known_process_ids: &[u32],
    timeout: Duration,
) -> Result<bool, Box<dyn Error>> {
    let started = Instant::now();
    loop {
        // A Controller can close its socket before its asynchronous cleanup finishes.
        // The Launcher cannot finish shutdown while that process remains alive.
        let known_alive = known_process_ids
            .iter()
            .copied()
            .any(|process_id| process_snapshot(process_id).is_ok());
        if matching_controller_process_ids(descriptor)?.is_empty()
            && !known_alive
            && !endpoint_ready(descriptor.control_port, Duration::from_millis(50))
        {
            return Ok(true);
        }
        if started.elapsed() >= timeout {
            return Ok(false);
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn command_line_arguments(command: &str) -> Vec<String> {
    let mut arguments = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    for character in command.chars() {
        match (quote, character) {
            (Some(delimiter), value) if value == delimiter => quote = None,
            (Some(_), value) => current.push(value),
            (None, '"' | '\'') => quote = Some(character),
            (None, value) if value.is_whitespace() => {
                if !current.is_empty() {
                    arguments.push(std::mem::take(&mut current));
                }
            }
            (None, value) => current.push(value),
        }
    }
    if !current.is_empty() {
        arguments.push(current);
    }
    arguments
}

#[cfg(target_os = "macos")]
pub(crate) fn process_arguments(process_id: u32) -> Result<Vec<String>, Box<dyn Error>> {
    let output = Command::new("/bin/ps")
        .args(["-ww", "-o", "command=", "-p", &process_id.to_string()])
        .output()?;
    if !output.status.success() {
        return Err(format!("cannot read command line for PID {process_id}").into());
    }
    let command = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if command.is_empty() {
        return Err(format!("PID {process_id} has an empty command line").into());
    }
    Ok(command_line_arguments(&command))
}

#[cfg(target_os = "linux")]
pub(crate) fn process_arguments(process_id: u32) -> Result<Vec<String>, Box<dyn Error>> {
    let bytes = std::fs::read(format!("/proc/{process_id}/cmdline"))?;
    let arguments = bytes
        .split(|byte| *byte == 0)
        .filter(|argument| !argument.is_empty())
        .map(|argument| String::from_utf8_lossy(argument).into_owned())
        .collect::<Vec<_>>();
    if arguments.is_empty() {
        return Err(format!("PID {process_id} has an empty command line").into());
    }
    Ok(arguments)
}

#[cfg(target_os = "macos")]
fn process_command_lines() -> Result<Vec<(u32, String)>, Box<dyn Error>> {
    let output = Command::new("/bin/ps")
        .args(["-axww", "-o", "pid=,command="])
        .output()?;
    if !output.status.success() {
        return Err("cannot list process command lines".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let (pid, command) = line.split_once(char::is_whitespace)?;
            Some((pid.parse().ok()?, command.trim().to_owned()))
        })
        .collect())
}

#[cfg(target_os = "linux")]
fn process_command_lines() -> Result<Vec<(u32, String)>, Box<dyn Error>> {
    let mut commands = Vec::new();
    for entry in std::fs::read_dir("/proc")?.filter_map(Result::ok) {
        let Some(process_id) = entry
            .file_name()
            .to_str()
            .and_then(|name| name.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(bytes) = std::fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        let command = bytes
            .split(|byte| *byte == 0)
            .filter(|argument| !argument.is_empty())
            .map(|argument| String::from_utf8_lossy(argument).into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        if !command.is_empty() {
            commands.push((process_id, command));
        }
    }
    Ok(commands)
}

#[cfg(target_os = "windows")]
fn process_command_lines() -> Result<Vec<(u32, String)>, Box<dyn Error>> {
    Ok(Vec::new())
}

/// A recorded launcher PID may since have been reused by an unrelated process.
/// Only an inspected executable matching this launcher proves ownership; a PID
/// the current user cannot inspect (for example a reused SYSTEM service PID)
/// is not ours to stop and must not block startup.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn recorded_launcher_is_current<E>(inspected: Result<PathBuf, E>, expected: &Path) -> bool {
    inspected
        .ok()
        .and_then(|path| path.canonicalize().ok())
        .is_some_and(|path| path == expected)
}

pub(super) fn managed_processes(
    data: &Path,
) -> Result<
    Option<(
        codexhost_platform::ProcessSnapshot,
        codexhost_platform::ProcessSnapshot,
    )>,
    Box<dyn Error>,
> {
    let Some(descriptor) = read_descriptor(&default_descriptor_path()?)? else {
        return Ok(None);
    };
    if !endpoint_ready(descriptor.control_port, Duration::from_millis(300)) {
        return Ok(None);
    }
    let document: serde_json::Value = serde_json::from_slice(&std::fs::read(
        data.join("diagnostics/desktop-controller-v1.json"),
    )?)?;
    let pid = document["pid"]
        .as_u64()
        .and_then(|pid| u32::try_from(pid).ok())
        .ok_or("Invalid Desktop Controller pid")?;
    let launcher = codexhost_platform::process_snapshot(descriptor.launcher_pid)?;
    let controller = codexhost_platform::process_snapshot(pid)?;
    if controller.parent_id != launcher.id {
        return Err("Desktop Controller does not belong to the recorded Launcher".into());
    }
    Ok(Some((launcher, controller)))
}

pub(super) fn stop_managed(data: &Path) -> Result<bool, Box<dyn Error>> {
    let Some((launcher, controller)) = managed_processes(data)? else {
        return Ok(false);
    };
    stop_controller(&launcher, &controller, Duration::from_secs(10))
        .map_err(|error| format!("stopping the managed Desktop failed: {error}"))?;
    Ok(true)
}

// The Launcher exits only after its Controller does. A Controller that keeps waiting on an
// unresponsive Renderer after SIGTERM is forced, so the Launcher can release Desktop ownership
// instead of failing the update and blocking the recovery Launcher.
fn stop_controller(
    launcher: &ProcessSnapshot,
    controller: &ProcessSnapshot,
    timeout: Duration,
) -> Result<(), Box<dyn Error>> {
    codexhost_platform::terminate_process_instance(controller, false)?;
    // Windows termination is already forceful, and escalating against an exited Controller
    // whose handle the Launcher still holds fails with access denied.
    let owner: Option<codexhost_platform::ProcessIdentity> =
        (!cfg!(target_os = "windows")).then(|| controller.into());
    crate::host_service::wait_for_shutdown(owner.as_ref(), Some(&launcher.into()), timeout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn descriptor(port: u16) -> RuntimeDescriptor {
        RuntimeDescriptor::new(10, port, "0123456789abcdef0123456789abcdef".into())
            .expect("runtime descriptor")
    }

    #[test]
    fn host_chain_ready_timeout_is_longer_on_windows() {
        assert_eq!(
            host_chain_ready_timeout(),
            if cfg!(target_os = "windows") {
                Duration::from_secs(90)
            } else {
                Duration::from_secs(30)
            }
        );
    }

    #[test]
    fn host_chain_stays_on_the_launched_process_snapshot() {
        let snapshot = process_snapshot(std::process::id()).expect("current process snapshot");
        let missing = PathBuf::from("codexhost-missing-host-chain-shim");
        let options = ResolvedLaunchOptions {
            shim: missing.clone(),
            node: missing.clone(),
            host_runtime: missing.clone(),
            desktop_controller: missing.clone(),
            renderer_extension: missing,
            pi: None,
        };
        let ready =
            wait_for_host_chain(&snapshot, &options, Duration::from_millis(150)).expect("wait");
        assert!(
            !ready,
            "a process without Shim/Node descendants is not Host-chain ready"
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn host_chain_does_not_adopt_another_live_root() {
        use codexhost_platform::{process_snapshot, spawn_supervised};
        use std::process::{Command, Stdio};

        let shell = Path::new("/bin/bash").canonicalize().unwrap();
        let sleep = Path::new("/bin/sleep").canonicalize().unwrap();
        let mut decoy = Command::new(&shell);
        decoy
            .args([
                "-c",
                "\"$1\" -c '\"$1\" 30 & wait' fixture \"$2\" & wait",
                "fixture",
            ])
            .arg(&shell)
            .arg(&sleep)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut decoy_root = spawn_supervised(&mut decoy).unwrap();
        let decoy_snapshot = process_snapshot(decoy_root.id()).unwrap();
        let options = ResolvedLaunchOptions {
            shim: shell,
            node: sleep.clone(),
            host_runtime: sleep.clone(),
            desktop_controller: sleep.clone(),
            renderer_extension: sleep.clone(),
            pi: None,
        };
        let decoy_ready =
            wait_for_host_chain(&decoy_snapshot, &options, Duration::from_secs(2)).unwrap();

        let mut launched = Command::new(&sleep);
        launched
            .arg("30")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut launched_root = spawn_supervised(&mut launched).unwrap();
        let launched_snapshot = process_snapshot(launched_root.id()).unwrap();
        let launched_ready =
            wait_for_host_chain(&launched_snapshot, &options, Duration::from_millis(250)).unwrap();

        decoy_root.force_terminate().unwrap();
        decoy_root.wait().unwrap();
        launched_root.force_terminate().unwrap();
        launched_root.wait().unwrap();
        assert!(
            decoy_ready,
            "the decoy tree must actually satisfy Host chain readiness"
        );
        assert!(
            !launched_ready,
            "Host chain readiness must stay on the launched process, not another live root"
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn stop_controller_forces_a_controller_that_ignores_sigterm() {
        use codexhost_platform::process_snapshot;
        use std::process::{Command, Stdio};

        // The fixture Launcher exits once its Controller child does, like the real Launcher. The
        // Controller reports its PID only after installing the SIGTERM trap.
        let mut command = Command::new("/bin/bash");
        command
            .args([
                "-c",
                "/bin/bash -c 'trap \"\" TERM; echo $$; while :; do sleep 0.05; done' & wait $!",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut launcher_child = command.spawn().unwrap();
        let mut line = String::new();
        BufReader::new(launcher_child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let controller = process_snapshot(line.trim().parse().unwrap()).unwrap();
        let launcher = process_snapshot(launcher_child.id()).unwrap();
        let reaper = thread::spawn(move || launcher_child.wait());

        let started = Instant::now();
        let result = stop_controller(&launcher, &controller, Duration::from_secs(6));
        let elapsed = started.elapsed();
        let _ = codexhost_platform::terminate_process_instance(&controller, true);
        reaper.join().unwrap().unwrap();
        assert!(
            result.is_ok(),
            "stuck Controller blocked shutdown: {result:?}"
        );
        // The Controller ignores SIGTERM, so only the 2s escalation can end it.
        assert!(
            elapsed >= Duration::from_secs(2) && elapsed < Duration::from_secs(6),
            "shutdown took {elapsed:?}"
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn host_chain_does_not_accept_unrelated_sibling_processes() {
        use codexhost_platform::{process_snapshot, spawn_supervised};
        use std::process::{Command, Stdio};

        let sleep = Path::new("/bin/sleep").canonicalize().unwrap();
        let mut command = Command::new("/bin/bash");
        command
            .args(["-c", "\"$1\" 30 & \"$1\" 30 & wait", "fixture"])
            .arg(&sleep)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut root = spawn_supervised(&mut command).unwrap();
        let snapshot = process_snapshot(root.id()).unwrap();
        let started = Instant::now();
        while codexhost_platform::process_snapshots()
            .unwrap()
            .iter()
            .filter(|process| process.parent_id == snapshot.id && process.executable == sleep)
            .count()
            < 2
        {
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "sibling fixture did not start"
            );
            thread::sleep(Duration::from_millis(10));
        }
        let options = ResolvedLaunchOptions {
            shim: sleep.clone(),
            node: sleep.clone(),
            host_runtime: sleep.clone(),
            desktop_controller: sleep.clone(),
            renderer_extension: sleep,
            pi: None,
        };
        // A pair of sibling executables is not a parent -> child runtime chain.
        let ready = wait_for_host_chain(&snapshot, &options, Duration::from_millis(200)).unwrap();
        root.force_terminate().unwrap();
        root.wait().unwrap();
        assert!(
            !ready,
            "unrelated descendants must not satisfy Host chain readiness"
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn host_chain_accepts_the_selected_child_of_a_descendant() {
        use codexhost_platform::{process_snapshot, spawn_supervised};
        use std::process::{Command, Stdio};

        let shell = Path::new("/bin/bash").canonicalize().unwrap();
        let sleep = Path::new("/bin/sleep").canonicalize().unwrap();
        let mut command = Command::new(&shell);
        command
            .args([
                "-c",
                "\"$1\" -c '\"$1\" 30 & wait' fixture \"$2\" & wait",
                "fixture",
            ])
            .arg(&shell)
            .arg(&sleep)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut root = spawn_supervised(&mut command).unwrap();
        let snapshot = process_snapshot(root.id()).unwrap();
        let options = ResolvedLaunchOptions {
            shim: shell,
            node: sleep.clone(),
            host_runtime: sleep.clone(),
            desktop_controller: sleep.clone(),
            renderer_extension: sleep,
            pi: None,
        };
        let ready = wait_for_host_chain(&snapshot, &options, Duration::from_secs(2)).unwrap();
        root.force_terminate().unwrap();
        root.wait().unwrap();
        assert!(
            ready,
            "the selected parent and child must satisfy Host chain readiness"
        );
    }

    #[test]
    fn npm_node_path_widens_host_runtime_node_candidates() {
        let default_node = PathBuf::from("/bin/sleep");
        assert_eq!(
            host_runtime_node_candidates(default_node.clone(), None),
            vec![default_node.clone()]
        );
        // A missing npm Node must not widen the accepted set.
        assert_eq!(
            host_runtime_node_candidates(
                default_node.clone(),
                Some(OsString::from("/nonexistent/codexhost-npm-node"))
            ),
            vec![default_node.clone()]
        );
        // An npm Node identical to the default adds nothing.
        assert_eq!(
            host_runtime_node_candidates(
                default_node.clone(),
                Some(default_node.clone().into_os_string())
            ),
            vec![default_node.clone()]
        );
        // Any existing file is sufficient; avoid a shared, writable temp fixture.
        let npm_node = env::current_exe().expect("current test executable");
        assert_eq!(
            host_runtime_node_candidates(
                default_node.clone(),
                Some(npm_node.clone().into_os_string())
            ),
            vec![default_node, npm_node]
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn host_chain_accepts_the_npm_runtime_node_instead_of_the_default_node() {
        use codexhost_platform::{process_snapshot, spawn_supervised};
        use std::process::{Command, Stdio};

        let shell = Path::new("/bin/bash").canonicalize().unwrap();
        let sleep = Path::new("/bin/sleep").canonicalize().unwrap();
        let mut command = Command::new(&shell);
        command
            .args([
                "-c",
                "\"$1\" -c '\"$1\" 30 & wait' fixture \"$2\" & wait",
                "fixture",
            ])
            .arg(&shell)
            .arg(&sleep)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut root = spawn_supervised(&mut command).unwrap();
        let snapshot = process_snapshot(root.id()).unwrap();
        // An npm launch resolves `options.node` to the Desktop cua_node while
        // the Shim actually runs the Host Runtime on the npm Node; the cua_node
        // under Desktop only appears later with unrelated MCP helpers.
        let options = ResolvedLaunchOptions {
            shim: shell.clone(),
            node: Path::new("/bin/cat").to_path_buf(),
            host_runtime: sleep.clone(),
            desktop_controller: sleep.clone(),
            renderer_extension: sleep,
            pi: None,
        };
        let not_ready = wait_for_host_chain_with_nodes(
            &snapshot,
            &options,
            std::slice::from_ref(&options.node),
            Duration::from_millis(200),
        )
        .unwrap();
        root.force_terminate().unwrap();
        root.wait().unwrap();
        assert!(
            !not_ready,
            "waiting only for the cua_node must not become ready"
        );
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn host_chain_becomes_ready_once_the_npm_node_pair_exists() {
        use codexhost_platform::{process_snapshot, spawn_supervised};
        use std::process::{Command, Stdio};

        let shell = Path::new("/bin/bash").canonicalize().unwrap();
        let sleep = Path::new("/bin/sleep").canonicalize().unwrap();
        let mut command = Command::new(&shell);
        command
            .args([
                "-c",
                "\"$1\" -c '\"$1\" 30 & wait' fixture \"$2\" & wait",
                "fixture",
            ])
            .arg(&shell)
            .arg(&sleep)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut root = spawn_supervised(&mut command).unwrap();
        let snapshot = process_snapshot(root.id()).unwrap();
        let options = ResolvedLaunchOptions {
            shim: shell,
            node: Path::new("/bin/cat").to_path_buf(),
            host_runtime: sleep.clone(),
            desktop_controller: sleep.clone(),
            renderer_extension: sleep.clone(),
            pi: None,
        };
        let nodes = host_runtime_node_candidates(
            options.node.clone(),
            Some(sleep.clone().into_os_string()),
        );
        let ready =
            wait_for_host_chain_with_nodes(&snapshot, &options, &nodes, Duration::from_secs(2))
                .unwrap();
        root.force_terminate().unwrap();
        root.wait().unwrap();
        assert!(
            ready,
            "the Shim-selected npm Node must satisfy Host chain readiness"
        );
    }

    fn snapshot(id: u32, parent_id: u32, started_at_micros: u64) -> ProcessSnapshot {
        ProcessSnapshot {
            id,
            parent_id,
            process_group_id: id,
            executable: PathBuf::from(format!("/fixture/{id}")),
            started_at_micros,
        }
    }

    fn wait_with_inspections(
        results: impl Fn(usize) -> Result<bool, PlatformError>,
    ) -> Result<bool, Box<dyn Error>> {
        let desktop = snapshot(10, 1, 100);
        let mut calls = 0;
        wait_for_host_chain_with_inspector(
            &desktop,
            Path::new("/fixture/shim"),
            &[PathBuf::from("/fixture/node")],
            Duration::from_millis(350),
            |_| {
                calls += 1;
                results(calls)
            },
        )
    }

    fn inspection_error() -> PlatformError {
        PlatformError::Invalid("tree not observable".into())
    }

    #[test]
    fn host_chain_timeout_is_not_an_error_after_a_complete_round_without_a_match() {
        // An early inspection error must not turn the later, fully observed
        // timeout into an Err that skips the caller's cleanup.
        let result = wait_with_inspections(|call| {
            if call == 1 {
                Err(inspection_error())
            } else {
                Ok(false)
            }
        });
        assert!(!result.expect("complete rounds make the timeout an ordinary one"));
    }

    #[test]
    fn host_chain_timeout_reports_inspection_errors_that_never_resolve() {
        assert!(wait_with_inspections(|_| Err(inspection_error())).is_err());
        // The latest round was incomplete, so the tree is still unobserved.
        let error = wait_with_inspections(|call| {
            if call == 1 {
                Ok(false)
            } else {
                Err(inspection_error())
            }
        })
        .expect_err("a trailing incomplete round keeps the error");
        assert!(error.to_string().contains("tree not observable"));
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn desktop_tree_requires_the_original_process_instance() {
        let desktop = snapshot(10, 1, 100);
        // The PID was recycled by a different process, which has its own child.
        let recycled = [snapshot(10, 1, 999), snapshot(11, 10, 1000)];
        assert!(snapshots_in_desktop_tree(&desktop, &recycled).is_none());
        assert!(snapshots_in_desktop_tree(&desktop, &[snapshot(12, 1, 100)]).is_none());
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn desktop_tree_walks_descendants_regardless_of_order_duplicates_or_cycles() {
        let desktop = snapshot(10, 1, 100);
        let snapshots = [
            // Listed before its parent, with a duplicate PID entry for 12.
            snapshot(13, 12, 130),
            snapshot(12, 11, 120),
            snapshot(12, 11, 121),
            snapshot(11, 10, 110),
            snapshot(10, 1, 100),
            // The root appears as a descendant of its own child.
            snapshot(14, 13, 140),
            snapshot(10, 14, 100),
            snapshot(20, 1, 200),
        ];
        let tree = snapshots_in_desktop_tree(&desktop, &snapshots).expect("Desktop is alive");
        let mut ids = tree.iter().map(|process| process.id).collect::<Vec<_>>();
        ids.sort_unstable();
        assert_eq!(ids, [10, 11, 12, 13, 14]);
    }

    #[test]
    fn recorded_launcher_requires_an_inspectable_matching_executable() {
        let expected = env::current_exe()
            .expect("current executable")
            .canonicalize()
            .expect("canonical current executable");

        let access_denied: Result<PathBuf, io::Error> =
            Err(io::Error::from(io::ErrorKind::PermissionDenied));
        assert!(!recorded_launcher_is_current(access_denied, &expected));

        let missing = expected.with_file_name("codexhost-missing-launcher-executable");
        assert!(!recorded_launcher_is_current(
            Ok::<_, io::Error>(missing),
            &expected
        ));

        let other = expected
            .parent()
            .expect("executable directory")
            .to_path_buf();
        assert!(!recorded_launcher_is_current(
            Ok::<_, io::Error>(other),
            &expected
        ));

        assert!(recorded_launcher_is_current(
            Ok::<_, io::Error>(expected.clone()),
            &expected
        ));
    }

    #[test]
    fn controlled_attachment_treats_busy_as_transient() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("attachment listener");
        let descriptor = descriptor(listener.local_addr().expect("attachment address").port());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("attachment connection");
            let mut request = String::new();
            BufReader::new(stream.try_clone().expect("clone stream"))
                .read_line(&mut request)
                .expect("attachment request");
            writeln!(stream, "busy").expect("attachment response");
        });

        assert!(!try_activate_controlled_instance(&descriptor).expect("busy Controller"));
        server.join().expect("attachment server");
    }

    #[test]
    fn controlled_attachment_treats_read_timeout_as_transient() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("attachment listener");
        let descriptor = descriptor(listener.local_addr().expect("attachment address").port());
        let server = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("attachment connection");
            let mut request = String::new();
            BufReader::new(stream.try_clone().expect("clone stream"))
                .read_line(&mut request)
                .expect("attachment request");
            thread::sleep(Duration::from_millis(100));
            drop(stream);
        });
        let stream = connect_controlled_instance(&descriptor).expect("Controller connection");

        assert!(
            !send_controlled_attachment_with_timeout(
                stream,
                &descriptor,
                Duration::from_millis(20)
            )
            .expect("timed-out Controller")
        );
        server.join().expect("attachment server");
    }

    #[test]
    fn controller_command_matches_exact_attachment_port_and_nonce() {
        let descriptor = descriptor(60218);
        assert!(command_line_matches_controller(
            "node release-main.js --attachment-port 60218 --attachment-nonce 0123456789abcdef0123456789abcdef",
            &descriptor
        ));
        assert!(
            !command_line_matches_controller(
                "node release-main.js --attachment-port 602181 --attachment-nonce 0123456789abcdef0123456789abcdef",
                &descriptor
            ),
            "port 60218 must not match 602181"
        );
        assert!(!command_line_matches_controller(
            "node release-main.js --attachment-port 60218 --attachment-nonce ffffffffffffffffffffffffffffffff",
            &descriptor
        ));
        assert!(!command_line_matches_controller(
            "node console-server.mjs serve",
            &descriptor
        ));
    }

    #[cfg(unix)]
    fn spawn_matching_listener(port: u16, nonce: &str, close_only: bool) -> std::process::Child {
        let signal_handler = if close_only {
            "signal.signal(signal.SIGTERM, lambda *_: server.close())\n"
        } else {
            ""
        };
        let script = format!(
            "import socket, time, signal\n\
             server = socket.socket()\n\
             server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\n\
             server.bind(('127.0.0.1', {port}))\n\
             server.listen(1)\n\
             {signal_handler}\
             while True:\n\
             \ttime.sleep(0.2)\n"
        );
        let mut command = std::process::Command::new("python3");
        command
            .args([
                "-c",
                &script,
                "--attachment-port",
                &port.to_string(),
                "--attachment-nonce",
                nonce,
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command.spawn().expect("start leftover Controller fixture")
    }

    #[cfg(unix)]
    fn wait_until_listening(port: u16) {
        let started = Instant::now();
        while !endpoint_ready(port, Duration::from_millis(50)) {
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "leftover Controller fixture did not listen"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(unix)]
    #[test]
    fn stop_orphaned_controller_terminates_a_matching_listener() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("reserve port");
        let port = listener.local_addr().expect("reserved address").port();
        drop(listener);
        let descriptor = descriptor(port);
        let mut child = spawn_matching_listener(port, &descriptor.nonce, false);
        wait_until_listening(port);

        let result = stop_orphaned_controller(&descriptor);
        let _ = child.kill();
        let _ = child.wait();
        result.expect("stop leftover Controller");
        assert!(
            !endpoint_ready(port, Duration::from_millis(50)),
            "matching leftover Controller kept its attachment port"
        );
    }

    #[cfg(unix)]
    #[test]
    fn stop_orphaned_controller_escalates_after_socket_closes_but_process_stays_alive() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("reserve port");
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let descriptor = descriptor(port);
        let mut child = spawn_matching_listener(port, &descriptor.nonce, true);
        wait_until_listening(port);
        let result = stop_orphaned_controller(&descriptor);
        let exited = child.try_wait().unwrap().is_some();
        let _ = child.kill();
        let _ = child.wait();
        result.expect("stop Controller whose socket closed during cleanup");
        assert!(exited, "Controller process survived shutdown");
    }

    #[cfg(unix)]
    #[test]
    fn stop_orphaned_controller_leaves_an_unrelated_listener() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("unrelated listener");
        let port = listener.local_addr().expect("unrelated address").port();
        let descriptor = descriptor(port);

        stop_orphaned_controller(&descriptor).expect("ignore unrelated listener");
        assert!(
            endpoint_ready(port, Duration::from_millis(50)),
            "unrelated listener on the recorded port was terminated"
        );
        drop(listener);
    }
}
