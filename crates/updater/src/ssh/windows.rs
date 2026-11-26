use base64::{Engine, engine::general_purpose::STANDARD};

use super::{Request, release_version};
use flate2::{Compression, write::GzEncoder};
use std::{error::Error, io::Write};

pub(super) fn command(script: &str) -> String {
    let bytes = script
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    format!(
        "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",
        STANDARD.encode(bytes)
    )
}

fn compressed_payload(script: &str) -> Result<String, Box<dyn Error>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(script.as_bytes())?;
    Ok(STANDARD.encode(encoder.finish()?))
}

pub(super) fn script_command(script: &str) -> Result<String, Box<dyn Error>> {
    let payload = compressed_payload(script)?;
    let bootstrap = format!(
        "$ErrorActionPreference='Stop'; $m=[IO.MemoryStream]::new([Convert]::FromBase64String('{payload}')); $g=[IO.Compression.GZipStream]::new($m,[IO.Compression.CompressionMode]::Decompress); $r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8); try {{ & ([ScriptBlock]::Create($r.ReadToEnd())) }} finally {{ $r.Dispose() }}"
    );
    let command = command(&bootstrap);
    if command.len() >= 8191 {
        return Err("Windows SSH installation command exceeds the cmd.exe limit".into());
    }
    Ok(command)
}

pub(super) fn script(request: &Request) -> Result<String, Box<dyn Error>> {
    let root = r#"$ErrorActionPreference = 'Stop'
$root = Join-Path $env:USERPROFILE '.codexhost\remote'
$manifest = Join-Path $root 'manifest.json'
"#;
    let marker = r#"if (Test-Path -LiteralPath $manifest) { [Console]::WriteLine('__CODEXHOST_SSH_STATE__=installed') } else { [Console]::WriteLine('__CODEXHOST_SSH_STATE__=not-installed') }"#;
    if request.action == "inspect" {
        return Ok(format!("{root}{marker}"));
    }
    let version = if request.action == "install" || request.action == "update" {
        Some(release_version(request)?)
    } else {
        None
    };
    let prerequisites = r#"
if (!(Get-Command node.exe -ErrorAction SilentlyContinue)) { exit 45 }
& node.exe -e 'const [a,b] = process.versions.node.split(String.fromCharCode(46)).map(Number);process.exit(a >= 24 || (a === 22 && b >= 19) ? 0 : 1)'
if ($LASTEXITCODE -ne 0) { exit 55 }
if (!(Get-Command npm.cmd -ErrorAction SilentlyContinue)) { exit 56 }
New-Item -ItemType Directory -Force -Path $root | Out-Null
try { $lock = [IO.File]::Open((Join-Path $root 'ssh-setup.lock'), 'OpenOrCreate', 'ReadWrite', 'None') } catch { exit 49 }
try {
$shared = $null
if (Test-Path -LiteralPath $manifest) { $saved = Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json; $shared = $saved.sharedDataDirectory }
function Remote([string[]] $arguments, [int] $failure) {
  & codexhost.cmd remote @arguments
  if ($LASTEXITCODE -ne 0) { exit $failure }
}
function InstallRemote {
  if ($shared) { Remote @('install', '--shared-data', $shared) 47 } else { Remote @('install') 47 }
}
"#;
    let action = match request.action.as_str() {
        "install" => format!(
            r#"
if (Test-Path -LiteralPath $manifest) {{ exit 43 }}
if (!(Get-Command codex.exe -ErrorAction SilentlyContinue) -and !(Get-Command codex.cmd -ErrorAction SilentlyContinue)) {{ exit 57 }}
& npm.cmd install -g '@karlorz/codexhost-cli@{}'; if ($LASTEXITCODE -ne 0) {{ exit 46 }}
if (!(Get-Command codexhost.cmd -ErrorAction SilentlyContinue)) {{ exit 54 }}
InstallRemote
Remote @('start') 48
"#,
            version.unwrap()
        ),
        "update" => format!(
            r#"
if (!(Test-Path -LiteralPath $manifest)) {{ exit 52 }}
if (!(Get-Command codexhost.cmd -ErrorAction SilentlyContinue)) {{ exit 58 }}
& npm.cmd view '@karlorz/codexhost-cli@{0}' version --fetch-retries=0 --fetch-timeout=30000; if ($LASTEXITCODE -ne 0) {{ exit 53 }}
Remote @('stop') 50
& npm.cmd install -g '@karlorz/codexhost-cli@{0}'; if ($LASTEXITCODE -ne 0) {{ & codexhost.cmd remote start; exit 46 }}
InstallRemote
Remote @('start') 48
"#,
            version.unwrap()
        ),
        "repair" => r#"
if (!(Get-Command codexhost.cmd -ErrorAction SilentlyContinue)) { exit 58 }
Remote @('stop') 50
Remote @('uninstall') 51
InstallRemote
Remote @('start') 48
"#
        .to_owned(),
        "uninstall" => {
            let check = if request.uninstall_package {
                r#"
$prefix = (& npm.cmd prefix -g | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { exit 59 }
$active = (Get-Command codexhost.cmd -ErrorAction Stop).Source
if ([IO.Path]::GetFullPath($active) -ine [IO.Path]::GetFullPath((Join-Path $prefix 'codexhost.cmd'))) { exit 59 }
"#
            } else {
                ""
            };
            let remove = if request.uninstall_package {
                "& npm.cmd uninstall -g '@karlorz/codexhost-cli'; if ($LASTEXITCODE -ne 0) { exit 60 }"
            } else {
                ""
            };
            format!(
                r#"
if (!(Get-Command codexhost.cmd -ErrorAction SilentlyContinue)) {{ exit 58 }}
{check}
if (Test-Path -LiteralPath $manifest) {{ Remote @('stop') 50 }}
Remote @('uninstall') 51
{remove}
"#
            )
        }
        _ => return Err("Unknown SSH action".into()),
    };
    Ok(format!(
        "{root}{prerequisites}{action}{marker}\n}} finally {{ $lock.Dispose() }}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoded_command_round_trips_shell_metacharacters_and_unicode() {
        let script = "$path = 'C:\\Users\\name & other\\你好'; Write-Output $path";
        let command = command(script);
        let bytes = STANDARD
            .decode(command.split_whitespace().last().unwrap())
            .unwrap();
        let utf16 = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        assert_eq!(String::from_utf16(&utf16).unwrap(), script);
    }

    #[test]
    fn compressed_script_round_trips_unicode_and_shell_metacharacters() {
        use std::io::Read;
        let script = "$path = 'C:\\Users\\name & other\\你好'; Write-Output $path";
        let bytes = STANDARD
            .decode(compressed_payload(script).unwrap())
            .unwrap();
        let mut decoded = String::new();
        flate2::read::GzDecoder::new(bytes.as_slice())
            .read_to_string(&mut decoded)
            .unwrap();
        assert_eq!(decoded, script);
    }

    #[test]
    fn windows_actions_use_native_commands_and_preserve_the_shared_directory() {
        for action in ["inspect", "install", "update", "repair", "uninstall"] {
            let request = Request {
                hostname: "msi-1".into(),
                port: None,
                identity: None,
                action: action.into(),
                version: Some("0.22.0-2".into()),
                uninstall_package: false,
            };
            let script = script(&request).unwrap();
            assert!(script_command(&script).unwrap().len() < 8191);
            assert!(script.contains("__CODEXHOST_SSH_STATE__=installed"));
            assert!(!script.contains("/bin/sh"));
            assert!(!script.contains("DefaultShell"));
            if action != "inspect" {
                assert!(script.contains("--shared-data"));
                assert!(script.contains("$lock.Dispose()"));
            }
        }
    }
    #[cfg(target_os = "windows")]
    #[test]
    fn executes_windows_install_update_repair_and_uninstall_with_cli_boundaries_stubbed() {
        let home =
            std::env::temp_dir().join(format!("cx-windows-ssh-script-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let mocks = r#"
$global:calls = @()
function global:node.exe { $global:LASTEXITCODE = 0 }
function global:npm.cmd { $global:calls += 'npm ' + ($args -join ' '); $global:LASTEXITCODE = 0 }
function global:codex.exe { $global:LASTEXITCODE = 0 }
function global:codexhost.cmd {
  $global:calls += $args -join ' '
  if ($args[1] -eq 'install') { '{"sharedDataDirectory":"C:\\shared host"}' | Set-Content -LiteralPath $manifest }
  if ($args[1] -eq 'uninstall') { Remove-Item -LiteralPath $manifest -ErrorAction SilentlyContinue }
  $global:LASTEXITCODE = 0
}
"#;
        let mut all = mocks.to_owned();
        for action in ["install", "update", "repair", "uninstall"] {
            let request = Request {
                hostname: "windows".into(),
                port: None,
                identity: None,
                action: action.into(),
                version: Some("0.22.0-2".into()),
                uninstall_package: false,
            };
            all.push_str(&script(&request).unwrap());
            all.push_str("\n");
        }
        all.push_str("[Console]::WriteLine(($global:calls | ConvertTo-Json -Compress))");
        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", &script_command(&all).unwrap()])
            .env("USERPROFILE", &home)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            stdout.matches("__CODEXHOST_SSH_STATE__=installed").count(),
            3
        );
        assert!(stdout.contains("__CODEXHOST_SSH_STATE__=not-installed"));
        assert!(stdout.contains("remote install --shared-data C:"));
        assert!(stdout.contains("remote stop"));
        std::fs::remove_dir_all(home).unwrap();
    }
}
