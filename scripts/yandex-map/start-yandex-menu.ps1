$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDir '..\..')).Path
$python = 'C:\Users\0\AppData\Local\Programs\Python\Python312\python.exe'
$crawler = Join-Path $scriptDir 'yandex-maps-avito-transit-headless.py'
$defaultInput = Join-Path $projectRoot 'merged-listings-2026-06-02.json'
$resultFile = Join-Path $scriptDir 'avito-transit-yandex-result.json'

if (-not (Test-Path $python)) {
  throw "Python not found: $python"
}

if (-not (Test-Path $crawler)) {
  throw "Crawler script not found: $crawler"
}

$env:CRAWL4_AI_BASE_DIRECTORY = $projectRoot

function Read-MenuChoice {
  param(
    [string]$Prompt,
    [string[]]$Allowed
  )

  while ($true) {
    $value = Read-Host $Prompt
    if ($Allowed -contains $value) {
      return $value
    }
    Write-Host "Choose one of: $($Allowed -join ', ')" -ForegroundColor Yellow
  }
}

function Pick-InputFile {
  $files = Get-ChildItem -Path $projectRoot -Filter '*.json' -File | Sort-Object Name
  if (-not $files) {
    throw "No JSON files found in $projectRoot"
  }

  Write-Host ''
  Write-Host 'Available JSON files:' -ForegroundColor Cyan
  for ($i = 0; $i -lt $files.Count; $i++) {
    $n = $i + 1
    Write-Host ("  {0}. {1}" -f $n, $files[$i].Name)
  }

  while ($true) {
    $choice = Read-Host 'Pick a file number'
    if ([int]::TryParse($choice, [ref]$null)) {
      $index = [int]$choice - 1
      if ($index -ge 0 -and $index -lt $files.Count) {
        return $files[$index].FullName
      }
    }
    Write-Host 'Invalid selection.' -ForegroundColor Yellow
  }
}

function Run-Crawler {
  param(
    [string]$InputPath,
    [bool]$Headed,
    [bool]$SaveHtml
  )

  $args = @($crawler, $InputPath)
  if ($Headed) {
    $args += '--headed'
  } else {
    $args += '--headless'
  }

  if ($SaveHtml) {
    $args += '--save-html'
  }

  Write-Host ''
  Write-Host 'Running:' -ForegroundColor Green
  Write-Host ("  {0} {1}" -f $python, ($args -join ' '))
  Write-Host ("  Output: {0}" -f $resultFile)
  Write-Host ''

  & $python @args
}

while ($true) {
  Clear-Host
  Write-Host 'Yandex Maps transit launcher' -ForegroundColor Cyan
  Write-Host ("Project: {0}" -f $projectRoot)
  Write-Host ("Result:  {0}" -f $resultFile)
  Write-Host ''
  Write-Host '1. Run default input (merged-listings-2026-06-02.json)'
  Write-Host '2. Run result.json'
  Write-Host '3. Pick any JSON from project root'
  Write-Host '4. Open output folder'
  Write-Host '0. Exit'
  Write-Host ''

  $choice = Read-MenuChoice -Prompt 'Select action' -Allowed @('0', '1', '2', '3', '4')

  switch ($choice) {
    '0' { break }
    '4' {
      Start-Process explorer.exe $scriptDir
      Pause
    }
    '1' {
      $headed = (Read-MenuChoice -Prompt 'Mode: 1=headless, 2=headed' -Allowed @('1', '2')) -eq '2'
      $saveHtml = (Read-MenuChoice -Prompt 'Save HTML? 1=no, 2=yes' -Allowed @('1', '2')) -eq '2'
      Run-Crawler -InputPath $defaultInput -Headed:$headed -SaveHtml:$saveHtml
      Pause
    }
    '2' {
      $input = Join-Path $projectRoot 'result.json'
      $headed = (Read-MenuChoice -Prompt 'Mode: 1=headless, 2=headed' -Allowed @('1', '2')) -eq '2'
      $saveHtml = (Read-MenuChoice -Prompt 'Save HTML? 1=no, 2=yes' -Allowed @('1', '2')) -eq '2'
      Run-Crawler -InputPath $input -Headed:$headed -SaveHtml:$saveHtml
      Pause
    }
    '3' {
      $input = Pick-InputFile
      $headed = (Read-MenuChoice -Prompt 'Mode: 1=headless, 2=headed' -Allowed @('1', '2')) -eq '2'
      $saveHtml = (Read-MenuChoice -Prompt 'Save HTML? 1=no, 2=yes' -Allowed @('1', '2')) -eq '2'
      Run-Crawler -InputPath $input -Headed:$headed -SaveHtml:$saveHtml
      Pause
    }
  }
}

