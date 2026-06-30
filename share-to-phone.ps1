param(
    [switch]$Serve,
    [int]$Port = 8765
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$distDir = Join-Path $projectRoot "dist"
$zipPath = Join-Path $distDir "daily-plan-termux.zip"
$stageDir = Join-Path $distDir "daily-plan-termux"

function Remove-IfExists {
    param([string]$Path)
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

function Copy-FilteredTree {
    param(
        [string]$Source,
        [string]$Destination
    )

    $excludeDirs = @(
        ".git",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        "__pycache__",
        ".venv",
        "venv",
        "data",
        "dist"
    )

    $excludeFiles = @(
        ".env",
        "daily_plan.db"
    )

    Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
        if ($excludeDirs -contains $_.Name) { return }
        if ($excludeFiles -contains $_.Name) { return }

        $target = Join-Path $Destination $_.Name
        if ($_.PSIsContainer) {
            New-Item -ItemType Directory -Path $target -Force | Out-Null
            Copy-FilteredTree -Source $_.FullName -Destination $target
        } else {
            Copy-Item -LiteralPath $_.FullName -Destination $target -Force
        }
    }
}

Remove-IfExists $stageDir
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
New-Item -ItemType Directory -Path $distDir -Force | Out-Null

Copy-FilteredTree -Source $projectRoot -Destination $stageDir

Remove-IfExists $zipPath
Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath -CompressionLevel Optimal

Write-Host ""
Write-Host "[OK] 已生成手机传输包：" -ForegroundColor Green
Write-Host $zipPath
Write-Host ""
Write-Host "包内已排除：.git / data / .env / 缓存目录" -ForegroundColor DarkGray
Write-Host "手机端解压后可直接运行：" -ForegroundColor DarkGray
Write-Host "bash ./termux-install.sh"
Write-Host "bash ./termux-start.sh"

if (-not $Serve) {
    return
}

$preferredConfigs = Get-NetIPConfiguration |
    Where-Object {
        $_.IPv4Address -and
        $_.IPv4DefaultGateway -and
        $_.InterfaceAlias -notmatch 'Mihomo|cfw|vEthernet|Bluetooth|以太网 2'
    }

if (-not $preferredConfigs) {
    $preferredConfigs = Get-NetIPConfiguration |
        Where-Object {
            $_.IPv4Address -and
            $_.IPv4DefaultGateway -and
            $_.InterfaceAlias -notmatch 'Mihomo|cfw|vEthernet|Bluetooth'
        }
}

$shareIp = $preferredConfigs |
    ForEach-Object { $_.IPv4Address.IPAddress } |
    Where-Object { $_ -notmatch '^127\.' } |
    Select-Object -First 1
if (-not $shareIp) {
    throw "未找到可用于手机访问的本机 IPv4 地址。"
}

Push-Location $distDir
try {
    Write-Host ""
    Write-Host "[SHARE] 在当前网络下，用手机浏览器打开：" -ForegroundColor Cyan
    Write-Host "http://$shareIp`:$Port/daily-plan-termux.zip"
    Write-Host ""
    Write-Host "[STOP] 结束分享时按 Ctrl+C" -ForegroundColor DarkGray
    python -m http.server $Port --bind 0.0.0.0
}
finally {
    Pop-Location
}
