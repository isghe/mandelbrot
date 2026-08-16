# Elevated: start an ETW session on the network stack, so a stalled probe run
# can be inspected for where the loopback bytes wait. Observation only — no
# system setting is changed, and trace-stop.ps1 tears the session down.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File trace-start.ps1
#
# Providers: TCPIP (connection lifecycle and datapath), Winsock-AFD (what the
# applications themselves ask for), WFP (the filtering engine third-party
# network drivers plug into).
$ErrorActionPreference = 'Stop'
$diag = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $diag 'out\trace-start.log'
$etl = Join-Path $diag 'out\net-trace.etl'
$session = 'ClaudeNetTrace'
$providers = @(
  'Microsoft-Windows-TCPIP',
  'Microsoft-Windows-Winsock-AFD',
  'Microsoft-Windows-WFP'
)

try {
  New-Item -ItemType Directory -Force (Join-Path $diag 'out') | Out-Null
  try { & logman stop $session -ets | Out-Null } catch { }
  Remove-Item $etl -Force -ErrorAction SilentlyContinue

  $lines = @()
  # All keywords, Informational: these providers are only chatty while something
  # is actually happening on the network, and the probe window is under a minute.
  $lines += (& logman start $session -p $providers[0] 0xffffffffffffffff 0x4 -o $etl -max 512 -ets) -join ' '
  foreach ($p in $providers[1..($providers.Count - 1)]) {
    $lines += (& logman update trace $session -p $p 0xffffffffffffffff 0x4 -ets) -join ' '
  }
  @('OK started', "etl=$etl") + $lines | Set-Content $log -Encoding utf8
} catch {
  @('FAILED', $_.Exception.Message) | Set-Content $log -Encoding utf8
}
