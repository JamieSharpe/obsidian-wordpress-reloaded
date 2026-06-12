$pluginDir = "C:\Users\Jamie\obsidian-vault\.obsidian\plugins\obsidian-wordpress"

Write-Host "Building..."
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Error "Build failed."
    exit 1
}

if (-not (Test-Path $pluginDir)) {
    New-Item -ItemType Directory -Path $pluginDir | Out-Null
}

Copy-Item -Path "main.js", "manifest.json", "styles.css" -Destination $pluginDir -Force

Write-Host "Deployed to $pluginDir"
