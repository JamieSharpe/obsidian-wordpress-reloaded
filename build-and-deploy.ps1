param(
  [ValidateSet('debug', 'production')]
  [string]$Mode = 'debug'
)

$pluginDir = "C:\Users\Jamie\obsidian-vault\.obsidian\plugins\obsidian-wordpress"

Write-Host "Building in $Mode mode..."

if ($Mode -eq 'production') {
  npm run build
} else {
  npm run build:debug
}

if ($LASTEXITCODE -ne 0) {
  Write-Error "Build failed."
  exit 1
}

if (-not (Test-Path $pluginDir)) {
  New-Item -ItemType Directory -Path $pluginDir | Out-Null
}

Copy-Item -Path "main.js", "manifest.json", "styles.css" -Destination $pluginDir -Force

Write-Host "Deployed to $pluginDir"
