$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Quote-WindowsArgument([string] $Value) {
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}
if ([string]::IsNullOrEmpty($env:SSH_ORIGINAL_COMMAND)) { throw 'This key requires a remote command' }
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = 'C:\Program Files\Git\bin\bash.exe'
$start.Arguments = '--noprofile --norc -c ' + (Quote-WindowsArgument $env:SSH_ORIGINAL_COMMAND)
$start.UseShellExecute = $false
$start.EnvironmentVariables['SHELL'] = '/bin/bash'
$process = [System.Diagnostics.Process]::Start($start)
$process.WaitForExit()
exit $process.ExitCode
