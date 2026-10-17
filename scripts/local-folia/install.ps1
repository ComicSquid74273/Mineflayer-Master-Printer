$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$serverDir = Join-Path $projectRoot 'local-folia-server'
$javaDir = Join-Path $serverDir 'java'
$downloadsDir = Join-Path $serverDir 'downloads'
$headers = @{ 'User-Agent' = 'FoliaLocalInstaller/26.2' }

New-Item -ItemType Directory -Force -Path $serverDir, $downloadsDir, (Join-Path $serverDir 'logs') | Out-Null

$buildsResponse = Invoke-WebRequest -Headers $headers -Uri 'https://fill.papermc.io/v3/projects/folia/versions/26.2/builds' -UseBasicParsing
$builds = $buildsResponse.Content | ConvertFrom-Json
$build = $builds | Sort-Object { [int]$_.id } -Descending | Select-Object -First 1
if (-not $build) { throw 'No Folia 26.2 build found.' }

$download = $build.downloads.'server:default'
$foliaJar = Join-Path $serverDir 'folia.jar'
Invoke-WebRequest -Headers $headers -Uri $download.url -OutFile $foliaJar
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $foliaJar).Hash.ToLowerInvariant()
if ($actualHash -ne ([string]$download.checksums.sha256).ToLowerInvariant()) {
  throw 'Downloaded Folia checksum does not match PaperMC metadata.'
}

if (-not (Test-Path -LiteralPath (Join-Path $javaDir 'bin\java.exe'))) {
  $javaZip = Join-Path $downloadsDir 'java25.zip'
  $javaExtract = Join-Path $downloadsDir 'java25-extract'
  & curl.exe -fL --retry 5 --retry-delay 3 -A $headers.'User-Agent' -o $javaZip 'https://api.adoptium.net/v3/binary/latest/25/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk'
  if ($LASTEXITCODE -ne 0) { throw 'Java 25 download failed.' }
  New-Item -ItemType Directory -Force -Path $javaExtract | Out-Null
  Expand-Archive -LiteralPath $javaZip -DestinationPath $javaExtract -Force
  $jdkRoot = Get-ChildItem -LiteralPath $javaExtract -Directory | Select-Object -First 1
  if (-not $jdkRoot -or -not (Test-Path -LiteralPath (Join-Path $jdkRoot.FullName 'bin\java.exe'))) {
    throw 'Java 25 archive layout was not recognized.'
  }
  Move-Item -LiteralPath $jdkRoot.FullName -Destination $javaDir
}

$rconPasswordFile = Join-Path $serverDir '.rconpass'
if (-not (Test-Path -LiteralPath $rconPasswordFile)) {
  $characters = (48..57) + (65..90) + (97..122)
  $rconPassword = -join ($characters | Get-Random -Count 32 | ForEach-Object { [char]$_ })
  Set-Content -LiteralPath $rconPasswordFile -Value $rconPassword -NoNewline
} else {
  $rconPassword = (Get-Content -LiteralPath $rconPasswordFile -Raw).Trim()
}

Set-Content -LiteralPath (Join-Path $serverDir 'eula.txt') -Value 'eula=true'
@"
server-ip=127.0.0.1
server-port=25565
level-seed=-4172144997902289642
online-mode=false
white-list=false
enforce-whitelist=false
allow-flight=true
spawn-protection=0
difficulty=peaceful
enable-command-block=true
enable-rcon=true
broadcast-rcon-to-ops=false
rcon.port=25575
rcon.password=$rconPassword
enable-query=false
view-distance=8
simulation-distance=6
motd=Local Folia 26.2
"@ | Set-Content -LiteralPath (Join-Path $serverDir 'server.properties')

[ordered]@{
  minecraftVersion = '26.2'
  foliaBuild = [int]$build.id
  foliaChannel = [string]$build.channel
  foliaFile = [string]$download.name
  foliaSha256 = $actualHash
  installedAt = (Get-Date).ToString('o')
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $serverDir 'install-info.json')

Write-Output "Installed Folia 26.2 build $($build.id) ($($build.channel)) at $serverDir"
Write-Output 'Whitelist: disabled'
Write-Output 'Address: 127.0.0.1:25565'
