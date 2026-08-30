# ============================================================
# CONTROL TOWER - DATABASE POPULATION
# ============================================================
# Populates the database used by the API at BaseUrl. When BaseUrl is local,
# DATABASE_URL from .env decides whether PostgreSQL is local or remote.
# ============================================================

[CmdletBinding()]
param(
    [string]$BaseUrl = "http://localhost:3000/api",
    [ValidateRange(24, 720)] [int]$HistoryHours = 72,
    [ValidateRange(1, 20)] [int]$Density = 1,
    [switch]$AllowNonLocalDatabase,
    [switch]$NoReset,
    [switch]$SkipMigrations,
    [switch]$StartLocalApi,
    [switch]$VerboseOutput
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot ".env"
$BaseUrl = $BaseUrl.TrimEnd("/")
$managedApi = $null
$apiStdout = Join-Path ([System.IO.Path]::GetTempPath()) "nextwave-seed-api.stdout.log"
$apiStderr = Join-Path ([System.IO.Path]::GetTempPath()) "nextwave-seed-api.stderr.log"

function Get-DotEnvValue {
    param([Parameter(Mandatory)][string]$Name)
    if (-not (Test-Path -LiteralPath $envPath)) { return $null }
    $escapedName = [regex]::Escape($Name)
    $line = Get-Content -LiteralPath $envPath |
        Where-Object { $_ -match "^\s*$escapedName\s*=" } |
        Select-Object -First 1
    if (-not $line) { return $null }
    return (($line -split "=", 2)[1].Trim()).Trim('"').Trim("'")
}

function Get-DatabaseDescription {
    param([Parameter(Mandatory)][string]$DatabaseUrl)
    try {
        $uri = [System.Uri]$DatabaseUrl
        return "$($uri.Host):$($uri.Port)/$($uri.AbsolutePath.Trim('/'))"
    }
    catch { return "configured DATABASE_URL (details unavailable)" }
}

function Test-IsLocalDatabase {
    param([Parameter(Mandatory)][string]$DatabaseUrl)
    return $DatabaseUrl -match "(@localhost:|@127\.0\.0\.1:|@host\.docker\.internal:)"
}

function Get-HealthUrl {
    if ($BaseUrl -match "/api$") {
        return "$($BaseUrl.Substring(0, $BaseUrl.Length - 4))/health"
    }
    return "$BaseUrl/health"
}

function Invoke-ControlTowerApi {
    param(
        [Parameter(Mandatory)][ValidateSet("Get", "Post", "Patch", "Delete")][string]$Method,
        [Parameter(Mandatory)][string]$Path,
        [hashtable]$Body,
        [int]$TimeoutSec = 900
    )
    $params = @{
        Uri = "$BaseUrl/$($Path.TrimStart('/'))"
        Method = $Method
        TimeoutSec = $TimeoutSec
    }
    if ($null -ne $Body) {
        $params.ContentType = "application/json"
        $params.Body = $Body | ConvertTo-Json -Depth 15 -Compress
    }
    return Invoke-RestMethod @params
}

function Wait-ForApi {
    param([int]$Seconds = 60)
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        try {
            $null = Invoke-RestMethod -Uri (Get-HealthUrl) -Method Get -TimeoutSec 5
            return $true
        }
        catch { Start-Sleep -Seconds 2 }
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Show-Result {
    param([string]$Label, $Value)
    Write-Host "  $Label"
    if ($VerboseOutput) { $Value | ConvertTo-Json -Depth 30 }
}

function Stop-ManagedApi {
    if ($null -ne $script:managedApi -and -not $script:managedApi.HasExited) {
        Stop-Process -Id $script:managedApi.Id -Force -ErrorAction SilentlyContinue
    }
}

$databaseUrl = Get-DotEnvValue -Name "DATABASE_URL"
if (-not $databaseUrl) { throw "DATABASE_URL is missing from $envPath." }
$databaseDescription = Get-DatabaseDescription -DatabaseUrl $databaseUrl
$isLocalDatabase = Test-IsLocalDatabase -DatabaseUrl $databaseUrl
if (-not $isLocalDatabase -and -not $AllowNonLocalDatabase) {
    throw "Refusing to reset remote database $databaseDescription. Re-run with -AllowNonLocalDatabase after verifying the target."
}

Write-Host ""
Write-Host "============================================"
Write-Host " CONTROL TOWER - DATABASE POPULATION"
Write-Host "============================================"
Write-Host "Database : $databaseDescription"
Write-Host "API      : $BaseUrl"
Write-Host "History  : $HistoryHours hours, density $Density"
Write-Host "Reset    : $(-not $NoReset)"
Write-Host ""

Push-Location $projectRoot
try {
    if (-not $SkipMigrations) {
        Write-Host "[1/10] Validating Prisma schema and deploying pending migrations..."
        & npm.cmd exec -- prisma validate
        if ($LASTEXITCODE -ne 0) { throw "Prisma validation failed." }
        & npm.cmd exec -- prisma migrate deploy
        if ($LASTEXITCODE -ne 0) { throw "Prisma migration deployment failed." }
    }
    else { Write-Host "[1/10] Prisma migration step skipped by request." }

    if (-not (Wait-ForApi -Seconds 3)) {
        if (-not $StartLocalApi -or $BaseUrl -notmatch "^https?://(localhost|127\.0\.0\.1)(:|/)") {
            throw "API is not reachable at $(Get-HealthUrl). Start it or use -StartLocalApi with a local BaseUrl."
        }
        Write-Host "[2/10] Building and starting a temporary local API connected to the configured database..."
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw "Nest build failed before starting the temporary API." }
        # Start node directly so Stop-ManagedApi owns the actual server process;
        # starting through npm.cmd leaves an orphan child process on Windows.
        $managedApi = Start-Process -FilePath "node.exe" -ArgumentList @("dist/main.js") `
            -WorkingDirectory $projectRoot -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $apiStdout -RedirectStandardError $apiStderr
        if (-not (Wait-ForApi -Seconds 90)) {
            $details = if (Test-Path -LiteralPath $apiStderr) { Get-Content -Raw -LiteralPath $apiStderr } else { "No API error log." }
            throw "Temporary API did not become healthy. $details"
        }
    }
    else { Write-Host "[2/10] API health check passed." }

    Write-Host "[3/10] Seeding healthy history and rebuilding baselines..."
    $resetValue = if ($NoReset) { "false" } else { "true" }
    $seed = Invoke-ControlTowerApi -Method Post -Path "demo/seed?reset=$resetValue&historyHours=$HistoryHours&density=$Density"
    if (-not $seed.seeded) { throw "Seed was not applied: $($seed.reason)" }
    Show-Result -Label "$($seed.transactions) transactions, $($seed.baselines) baselines, $($seed.routes) routes, $($seed.merchants) merchants" -Value $seed

    Write-Host "[4/10] Seeding alert directory and escalation policies..."
    $alertsSeed = Invoke-ControlTowerApi -Method Post -Path "alerts/seed?resetRecipients=false"
    Show-Result -Label "$($alertsSeed.policies) policies; $($alertsSeed.recipients) recipients created" -Value $alertsSeed

    Write-Host "[5/10] Verifying healthy traffic before degradations..."
    $healthyDetection = Invoke-ControlTowerApi -Method Post -Path "detection/run" -Body @{ windowMinutes = 15 }
    if ($healthyDetection.outcome -ne "NO_ANOMALY") {
        throw "Healthy detection returned $($healthyDetection.outcome), expected NO_ANOMALY."
    }
    Show-Result -Label "Detection outcome: $($healthyDetection.outcome)" -Value $healthyDetection

    Write-Host "[6/10] Injecting two predictive early-warning patterns..."
    $predictiveCases = @(
        @{ merchant = "PagoTotal Retail"; provider = "dLocal"; method = "CARD"; country = "MX"; issuingBank = "Banorte"; transactionsPerMinute = 12 },
        @{ merchant = "Arena Gaming"; provider = "EBANX"; method = "PIX"; country = "BR"; issuingBank = "Banco do Brasil"; transactionsPerMinute = 10 }
    )
    foreach ($case in $predictiveCases) {
        $result = Invoke-ControlTowerApi -Method Post -Path "demo/inject-predictive-risk" -Body $case
        Show-Result -Label "$($result.transactions) predictive transactions for $($case.merchant)" -Value $result
    }
    $predictionScan = Invoke-ControlTowerApi -Method Get -Path "predictions/scan"
    Show-Result -Label "Prediction scan completed" -Value $predictionScan

    Write-Host "[7/10] Injecting four confirmed degradation profiles..."
    $incidentCases = @(
        @{
            merchant = "Mercado Uno"; provider = "dLocal"; method = "PIX"; country = "BR"; issuingBank = "Itau"
            approvalRate = 0.28; durationMinutes = 15; transactionsPerMinute = 30
            declineCode = "DECLINED_BY_PROVIDER"; errorType = "PROVIDER_TIMEOUT"
        },
        @{
            merchant = "PagoTotal Retail"; provider = "MercadoPago"; method = "CASH"; country = "MX"; issuingBank = "OXXO"
            approvalRate = 0.40; durationMinutes = 15; transactionsPerMinute = 28
            declineCode = "EXPIRED"; errorType = "PROVIDER_ERROR"
        },
        @{
            merchant = "Nova Travel"; provider = "dLocal"; method = "CARD"; country = "CO"; issuingBank = "Bancolombia"
            approvalRate = 0.23; durationMinutes = 15; transactionsPerMinute = 32
            declineCode = "REQUESTS_EXCEEDED"; errorType = "TERMINAL_ERROR"
        },
        @{
            merchant = "StreamPlus"; provider = "Stripe"; method = "CARD"; country = "MX"; issuingBank = "Citibanamex"
            approvalRate = 0.46; durationMinutes = 15; transactionsPerMinute = 24
            declineCode = "NO_RETRY_LIFE_CYCLE"; errorType = "PROVIDER_INVALID_RESPONSE"
        }
    )
    foreach ($case in $incidentCases) {
        $result = Invoke-ControlTowerApi -Method Post -Path "demo/inject-incident" -Body $case
        Show-Result -Label "$($result.transactions) degraded transactions for $($case.merchant) / $($case.provider)" -Value $result
    }

    Write-Host "[8/10] Running detection and creating incidents..."
    $detection = Invoke-ControlTowerApi -Method Post -Path "detection/run" -Body @{
        windowMinutes = 15
        maxDepth = 3
        minSampleSize = 20
    }
    if ($detection.outcome -ne "INCIDENTS_FOUND") {
        throw "Degraded detection returned $($detection.outcome), expected INCIDENTS_FOUND."
    }
    $incidentIds = @($detection.incidents | ForEach-Object { $_.incidentId } | Where-Object { $_ })
    if ($incidentIds.Count -lt 3) {
        throw "Detection created only $($incidentIds.Count) incidents; at least 3 are required for lifecycle variety."
    }
    Show-Result -Label "$($incidentIds.Count) incidents detected" -Value $detection

    Write-Host "[9/10] Creating OPEN, ACKNOWLEDGED and RESOLVED states..."
    $acknowledged = Invoke-ControlTowerApi -Method Patch -Path "incidents/$($incidentIds[1])/acknowledge" -Body @{}
    $resolved = Invoke-ControlTowerApi -Method Patch -Path "incidents/$($incidentIds[2])/resolve"
    Show-Result -Label "1 acknowledged, 1 resolved, $($incidentIds.Count - 2) left open" -Value @{
        acknowledged = $acknowledged
        resolved = $resolved
    }

    Write-Host "[10/10] Verifying final database state..."
    $transactionCount = Invoke-ControlTowerApi -Method Get -Path "transactions/count"
    $baselineCount = Invoke-ControlTowerApi -Method Get -Path "baselines/count"
    $incidentStats = Invoke-ControlTowerApi -Method Get -Path "incidents/stats"
    $incidents = Invoke-ControlTowerApi -Method Get -Path "incidents?limit=50"
    $analytics = Invoke-ControlTowerApi -Method Get -Path "analytics/summary?windowMinutes=60"
    $providers = Invoke-ControlTowerApi -Method Get -Path "analytics/breakdown?groupBy=provider&timeWindowMinutes=60"
    $policies = Invoke-ControlTowerApi -Method Get -Path "alerts/policies"
    $escalations = Invoke-ControlTowerApi -Method Get -Path "alerts/escalations?limit=50"

    Write-Host ""
    Write-Host "============================================"
    Write-Host " POPULATION COMPLETE"
    Write-Host "============================================"
    Write-Host "Transactions : $($transactionCount.count)"
    Write-Host "Baselines    : $($baselineCount.count)"
    Write-Host "Incidents    : $(@($incidents).Count) total"
    Write-Host "Open         : $($incidentStats.open)"
    Write-Host "Acknowledged : $($incidentStats.acknowledged)"
    Write-Host "Resolved     : $($incidentStats.resolved)"
    Write-Host "Analytics    : $($analytics.state)"
    Write-Host "Database     : $databaseDescription"
    Write-Host ""

    if ($VerboseOutput) {
        @{ incidents = $incidents; analytics = $analytics; providers = $providers; policies = $policies; escalations = $escalations } |
            ConvertTo-Json -Depth 40
    }
}
finally {
    Stop-ManagedApi
    Pop-Location
}
