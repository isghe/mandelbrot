# Elevated: stop the network ETW session and decode only what concerns the test
# server's port, so a multi-hundred-megabyte trace becomes a readable timeline.
# Reading an .etl needs elevation, which is why the decoding lives here.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File trace-stop.ps1
$ErrorActionPreference = 'Stop'
$diag = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $diag 'out\trace-stop.log'
$etl = Join-Path $diag 'out\net-trace.etl'
$out = Join-Path $diag 'out\net-trace-port8123.txt'
$session = 'MandelbrotNetTrace'
$port = 8123

try {
  try { & logman stop $session -ets | Out-Null } catch { }
  if (-not (Test-Path $etl)) { throw "no etl at $etl" }
  $etlMb = [math]::Round((Get-Item $etl).Length / 1MB, 1)

  $kept = 0
  $seen = 0
  $writer = [System.IO.StreamWriter]::new($out, $false, [System.Text.Encoding]::UTF8)
  try {
    Get-WinEvent -Path $etl -Oldest -ErrorAction Stop | ForEach-Object {
      $seen++
      # Any event naming the server port: that pulls in both ends of every
      # connection under test, without needing the ephemeral ports in advance.
      $props = ($_.Properties | ForEach-Object { $_.Value }) -join ' '
      if ($props -match "\b$port\b") {
        $kept++
        $writer.WriteLine(('{0:HH:mm:ss.fff} {1} id={2} {3} | {4}' -f
          $_.TimeCreated, $_.ProviderName, $_.Id, $_.ProcessId, $props))
      }
    }
  } finally {
    $writer.Close()
  }

  @('OK stopped', "etl_mb=$etlMb", "events_seen=$seen", "events_kept=$kept", "out=$out") |
    Set-Content $log -Encoding utf8
} catch {
  @('FAILED', $_.Exception.Message) | Set-Content $log -Encoding utf8
}
