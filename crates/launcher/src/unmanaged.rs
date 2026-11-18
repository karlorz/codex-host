//! Operator-owned leftovers that `codexhost stop` does not unload.
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const ENROLL_PREFIX: &str = "com.codexhost.enroll-";
const PLIST_SUFFIX: &str = ".plist";

fn enroll_agent_labels_in(directory: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut labels = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with(ENROLL_PREFIX) || !name.ends_with(PLIST_SUFFIX) {
            continue;
        }
        if name.contains(".retired") {
            continue;
        }
        labels.push(name.trim_end_matches(PLIST_SUFFIX).to_owned());
    }
    labels.sort();
    labels
}

/// LaunchAgent labels for enroll KeepAlive agents present on this Mac.
pub fn enroll_agent_labels() -> Vec<String> {
    let Some(home) = env::var_os("HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    enroll_agent_labels_in(&home.join("Library/LaunchAgents"))
}

pub fn leftover_lines() -> Vec<String> {
    enroll_agent_labels()
        .into_iter()
        .map(|label| format!("Enroll leftover: unmanaged {label}; stop does not unload KeepAlive"))
        .collect()
}

pub fn status_lines() -> Vec<String> {
    enroll_agent_labels()
        .into_iter()
        .map(|label| format!("Enroll: unmanaged {label} (stop does not unload KeepAlive)"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn lists_enroll_plists_and_skips_retired_names() {
        let root = std::env::temp_dir().join(format!("codexhost-enroll-{}", std::process::id()));
        let agents = root.join("LaunchAgents");
        fs::create_dir_all(&agents).expect("agents");
        fs::write(
            agents.join("com.codexhost.enroll-relay-link-muse.plist"),
            "fixture",
        )
        .expect("plist");
        fs::write(
            agents.join("com.codexhost.enroll-serve-muse.plist.retired-20261114"),
            "retired",
        )
        .expect("retired");
        fs::write(
            agents.join("ai.bytepioneer.codexhost.autostart.plist"),
            "auto",
        )
        .expect("auto");
        let labels = enroll_agent_labels_in(&agents);
        let _ = fs::remove_dir_all(&root);
        assert_eq!(labels, ["com.codexhost.enroll-relay-link-muse"]);
    }
}
