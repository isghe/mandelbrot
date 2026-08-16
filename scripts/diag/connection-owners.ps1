# Runs the stall probe and samples the TCP connection table while it runs, then
# joins the two: for every connection the server accepted, who owned the client
# end, which states it passed through, and how long the server waited for the
# request bytes. Answers "is a third process in the path, and where does a
# stalled connection actually sit?" without changing anything on the system.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/diag/connection-owners.ps1
$ErrorActionPreference = 'Stop'
$diag = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent (Split-Path -Parent $diag)
$label = 'proprietari'
$port = 8123

# Started as a child process, and sampled from this same script, because the
# two must overlap: a sampling window that misses the run reports nothing and
# looks like a finding.
$probe = Start-Process node -WorkingDirectory $repo -PassThru -WindowStyle Hidden -ArgumentList @(
  'scripts/diag/loopback-stall-probe.mjs', "--label=$label", '--mode=processes',
  '--browsers=3', '--loads=1', '--trace'
)

$names = @{}
$samples = @()
while (-not $probe.HasExited) {
  $now = (Get-Date).ToString('HH:mm:ss.fff')
  foreach ($c in (Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq $port -or $_.RemotePort -eq $port })) {
    $owner = $c.OwningProcess
    if (-not $names.ContainsKey($owner)) {
      $p = Get-Process -Id $owner -ErrorAction SilentlyContinue
      $names[$owner] = if ($p) { $p.ProcessName } else { "pid$owner" }
    }
    $samples += [pscustomobject]@{
      t = $now; local = $c.LocalPort; remote = $c.RemotePort
      state = $c.State; owner = $owner; name = $names[$owner]
    }
  }
  Start-Sleep -Milliseconds 250
}
$samplesCsv = Join-Path $diag ('out\owners-{0}.csv' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$samples | Export-Csv $samplesCsv -NoTypeInformation

# The server's own view of the same connections: accepted when, first request
# byte when.
$traceDir = Get-ChildItem (Join-Path $diag 'out') -Directory -Filter "$label-*" | Sort-Object Name -Descending | Select-Object -First 1
$accepted = @{}; $requested = @{}
foreach ($line in Get-Content (Join-Path $traceDir.FullName 'server-trace.log')) {
  $f = $line -split ' '
  if ($f.Count -lt 4) { continue }
  $p = $f[3] -replace 'port=', ''
  if ($f[2] -eq 'connection' -and -not $accepted.ContainsKey($p)) { $accepted[$p] = [int64]$f[0] }
  if ($f[2] -eq 'request' -and -not $requested.ContainsKey($p)) { $requested[$p] = [int64]$f[0] }
}

Write-Output "campioni=$($samples.Count) porte accettate dal server=$($accepted.Count)"
Write-Output ''
Write-Output 'porta   ritardo  proprietario lato client   stati osservati'
foreach ($p in ($accepted.Keys | Sort-Object { if ($requested.ContainsKey($_)) { -($requested[$_] - $accepted[$_]) } else { -999999 } })) {
  $delay = if ($requested.ContainsKey($p)) { "$($requested[$p] - $accepted[$p])ms" } else { 'MAI' }
  $rows = $samples | Where-Object { $_.local -eq $p -and $_.remote -eq $port }
  $owner = if ($rows) { ($rows.name | Select-Object -Unique) -join ',' } else { 'non campionato' }
  $states = if ($rows) { ($rows.state | Select-Object -Unique) -join ',' } else { '-' }
  Write-Output ('{0,-7} {1,-8} {2,-26} {3}' -f $p, $delay, $owner, $states)
}
