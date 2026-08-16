# Elevated, read-only: dump the Windows Filtering Platform state and list the
# non-Microsoft providers with callouts registered, and at which layers. This
# only enumerates what is installed; it changes nothing and disables nothing.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/diag/wfp-inventory.ps1
$ErrorActionPreference = 'Stop'
$diag = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $diag 'out'
$xml = Join-Path $out 'wfpstate.xml'
$log = Join-Path $out 'wfp-inventory.log'

try {
  New-Item -ItemType Directory -Force $out | Out-Null
  Remove-Item $xml -Force -ErrorAction SilentlyContinue
  Push-Location $out
  try { & netsh wfp show state file="$xml" | Out-Null } finally { Pop-Location }
  if (-not (Test-Path $xml)) { throw 'netsh produced no state file' }

  # Loaded from the file, not cast from a string: the state dump runs to tens of
  # megabytes and the cast both copies it and, when it fails, puts the whole
  # document into the exception message.
  $doc = New-Object System.Xml.XmlDocument
  $doc.Load($xml)
  # Callouts carry a providerKey and the layer they sit on; the display name is
  # what identifies the vendor.
  $callouts = $doc.SelectNodes('//callout') | ForEach-Object {
    [pscustomobject]@{
      name  = $_.displayData.name
      layer = $_.layerKey
      provider = $_.providerKey
    }
  }
  $report = @("callout totali=$($callouts.Count)", '')
  $report += '--- callout per nome (non Microsoft in cima) ---'
  $report += $callouts | Group-Object name | Sort-Object Count -Descending | ForEach-Object {
    '{0,4}  {1}' -f $_.Count, $_.Name
  }
  $report += ''
  $report += '--- layer occupati da callout il cui nome non contiene Microsoft/Windows ---'
  $report += $callouts | Where-Object { $_.name -notmatch 'Microsoft|Windows|WFP Built-in' } |
    Sort-Object name, layer | ForEach-Object { '{0,-45} {1}' -f $_.name, $_.layer }

  $report | Set-Content $log -Encoding utf8
} catch {
  # Truncated: an XML failure here would otherwise carry the whole state dump.
  @('FAILED', $_.Exception.Message.Substring(0, [Math]::Min(300, $_.Exception.Message.Length))) |
    Set-Content $log -Encoding utf8
}
