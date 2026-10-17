$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$serverDir = Join-Path $projectRoot 'local-folia-server'
$pidFile = Join-Path $serverDir 'folia.pid'
$java = Join-Path $serverDir 'java\bin\java.exe'

if (-not (Test-Path -LiteralPath $java)) {
  throw "Folia is not installed. Run: powershell -ExecutionPolicy Bypass -File `"$PSScriptRoot\install.ps1`""
}

if (Test-Path -LiteralPath $pidFile) {
  $existingPid = [int](Get-Content -LiteralPath $pidFile -Raw)
  if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
    Write-Output "Folia is already running. PID=$existingPid"
    exit 0
  }
  Remove-Item -LiteralPath $pidFile -Force
}

$logsDir = Join-Path $serverDir 'logs'
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$javaTemp = 'C:\jtmp'
New-Item -ItemType Directory -Force -Path $javaTemp | Out-Null
$env:TEMP = $javaTemp
$env:TMP = $javaTemp
$stdout = Join-Path $logsDir 'console.log'
$stderr = Join-Path $logsDir 'console-error.log'
$arguments = @(
  '-Xms2G',
  '-Xmx6G',
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=200',
  '-XX:+DisableExplicitGC',
  '-jar',
  'folia.jar',
  'nogui'
)

$process = Start-Process -FilePath $java -ArgumentList $arguments -WorkingDirectory $serverDir -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
Set-Content -LiteralPath $pidFile -Value $process.Id -NoNewline
Write-Output "Folia starting. PID=$($process.Id)"
Write-Output "Log: $stdout"
