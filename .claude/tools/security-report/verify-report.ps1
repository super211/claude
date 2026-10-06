# Verifies a generated .docx report with Microsoft Word (Windows only).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File verify-report.ps1 -Docx <report.docx> [-OutDir <dir>] [-TimeoutSec 240]
#
# 1. Opens the report read-only in a hidden Word instance (fails if Word can't open it),
#    prints the page count, and exports <name>.pdf. Word's PDF export can take ~1 minute.
# 2. Renders each PDF page to <name>-page-N.png so the layout can be inspected.
# Each stage runs in a background job with a timeout. On timeout, only the Word
# instance this script started is stopped; any Word windows the user has open are untouched.
# The report itself is never modified.

param(
  [Parameter(Mandatory = $true)][string]$Docx,
  [string]$OutDir,
  [int]$TimeoutSec = 240
)

$docxPath = (Resolve-Path $Docx).Path
if (-not $OutDir) { $OutDir = Split-Path -Parent $docxPath }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$base = [IO.Path]::GetFileNameWithoutExtension($docxPath)
$pdfPath = Join-Path $OutDir "$base.pdf"
Remove-Item $pdfPath -ErrorAction SilentlyContinue

# --- Stage 1: Word open + page count + PDF export ---------------------------------
$wordBefore = @(Get-Process WINWORD -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$wordJob = Start-Job -ScriptBlock {
  param($docxPath, $pdfPath)
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  try {
    $doc = $word.Documents.Open($docxPath, $false, $true, $false)   # read-only
    $pages = $doc.ComputeStatistics(2)                              # wdStatisticPages
    $doc.ExportAsFixedFormat($pdfPath, 17)                          # wdExportFormatPDF
    $doc.Close($false)
    "OK: Word opened $([IO.Path]::GetFileName($docxPath)) | pages: $pages"
  } catch {
    "FAIL: Word could not open or export the report: $($_.Exception.Message)"
  } finally {
    $word.Quit()
    # Release the COM reference so the hidden WINWORD.EXE actually exits.
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
  }
} -ArgumentList $docxPath, $pdfPath

if (Wait-Job $wordJob -Timeout $TimeoutSec) {
  $result = Receive-Job $wordJob
  Remove-Job $wordJob -Force
  # Belt and braces: stop any hidden Word this script started that is still lingering.
  Start-Sleep -Seconds 2
  Get-Process WINWORD -ErrorAction SilentlyContinue |
    Where-Object { $wordBefore -notcontains $_.Id -and -not $_.MainWindowTitle } | Stop-Process -Force
  Write-Output $result
  if ($result -match '^FAIL') { exit 1 }
} else {
  Stop-Job $wordJob; Remove-Job $wordJob -Force
  # Stop only Word processes started after this script began (never the user's own).
  Get-Process WINWORD -ErrorAction SilentlyContinue | Where-Object { $wordBefore -notcontains $_.Id } | Stop-Process -Force
  Write-Output "FAIL: Word did not finish within $TimeoutSec s (open/export hung). Is a Word dialog waiting for input?"
  exit 1
}
if (-not (Test-Path $pdfPath)) { Write-Output "FAIL: PDF was not produced"; exit 1 }
Write-Output "PDF: $pdfPath"

# --- Stage 2: render PDF pages to PNG (Windows.Data.Pdf, MTA job) ----------------
$renderJob = Start-Job -ScriptBlock {
  param($pdfPath, $outDir, $base)
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $ext = [System.WindowsRuntimeSystemExtensions].GetMethods()
  $asTaskOp = $ext | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' }
  $asTaskAct = $ext | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' }
  function Await($op, [type]$t) { $task = $asTaskOp.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(); $task.Result }
  function AwaitAction($op) { $task = $asTaskAct.Invoke($null, @($op)); $task.Wait() }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($pdfPath)) ([Windows.Storage.StorageFile])
  $pdf = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
  $images = @()
  for ($i = 0; $i -lt $pdf.PageCount; $i++) {
    $page = $pdf.GetPage($i)
    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    AwaitAction ($page.RenderToStreamAsync($stream))
    $png = Join-Path $outDir "$base-page-$($i + 1).png"
    $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream.GetInputStreamAt(0))
    $out = [IO.File]::Create($png); $net.CopyTo($out); $out.Close(); $page.Dispose()
    $images += $png
  }
  "PAGES: $($images -join ' ; ')"
} -ArgumentList $pdfPath, $OutDir, $base

if (Wait-Job $renderJob -Timeout 120) {
  Receive-Job $renderJob -ErrorAction SilentlyContinue
} else {
  Stop-Job $renderJob
  Write-Output "WARN: page rendering timed out; open the PDF to inspect the layout instead."
}
Remove-Job $renderJob -Force
exit 0
