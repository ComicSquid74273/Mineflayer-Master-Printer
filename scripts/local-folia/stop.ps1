$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$serverDir = Join-Path $projectRoot 'local-folia-server'
$pidFile = Join-Path $serverDir 'folia.pid'
$rconPassword = (Get-Content -LiteralPath (Join-Path $serverDir '.rconpass') -Raw).Trim()

if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Output 'Folia is already stopped.'
  exit 0
}

$serverPid = [int](Get-Content -LiteralPath $pidFile -Raw)
if (-not (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) {
  Remove-Item -LiteralPath $pidFile -Force
  Write-Output 'Folia is already stopped.'
  exit 0
}

function New-RconPacket([int]$requestId, [int]$packetType, [string]$body) {
  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  $memory = [System.IO.MemoryStream]::new()
  $writer = [System.IO.BinaryWriter]::new($memory)
  $writer.Write([int](10 + $bodyBytes.Length))
  $writer.Write($requestId)
  $writer.Write($packetType)
  $writer.Write($bodyBytes)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Flush()
  return $memory.ToArray()
}

function Read-RconPacket([System.IO.Stream]$stream) {
  $reader = [System.IO.BinaryReader]::new($stream, [System.Text.Encoding]::UTF8, $true)
  $length = $reader.ReadInt32()
  $requestId = $reader.ReadInt32()
  $packetType = $reader.ReadInt32()
  $remaining = $reader.ReadBytes($length - 8)
  return @{ RequestId = $requestId; Type = $packetType }
}

$client = [System.Net.Sockets.TcpClient]::new()
try {
  $client.Connect('127.0.0.1', 25575)
  $stream = $client.GetStream()
  $auth = New-RconPacket 10 3 $rconPassword
  $stream.Write($auth, 0, $auth.Length)
  $authResponse = Read-RconPacket $stream
  if ($authResponse.RequestId -eq -1) { throw 'RCON authentication failed.' }
  $stop = New-RconPacket 11 2 'stop'
  $stream.Write($stop, 0, $stop.Length)
  Write-Output 'Graceful stop requested.'
} finally {
  $client.Dispose()
}

if (Test-Path -LiteralPath $pidFile) {
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Process -Id $serverPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
  }
  if (Get-Process -Id $serverPid -ErrorAction SilentlyContinue) {
    throw "Folia did not stop within 90 seconds. PID=$serverPid"
  }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
}

Write-Output 'Folia stopped.'
