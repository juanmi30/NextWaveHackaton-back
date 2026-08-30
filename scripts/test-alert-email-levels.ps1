param(
    [string]$BaseUrl = "http://localhost:3000/api",
    [string]$IncidentId = "",
    [string]$TargetEmail = "",
    [switch]$ResetDemoData,
    [switch]$AllowNonLocalDatabase
)

$ErrorActionPreference = "Stop"

function Get-DotEnvValue {
    param([string]$Name)

    if (-not (Test-Path ".env")) {
        return $null
    }

    $line = Get-Content ".env" |
        Where-Object { $_ -match "^$Name=" } |
        Select-Object -First 1

    if (-not $line) {
        return $null
    }

    return $line.Substring($Name.Length + 1).Trim('"').Trim("'")
}

$databaseUrl = Get-DotEnvValue "DATABASE_URL"
if (
    -not $AllowNonLocalDatabase -and
    $databaseUrl -and
    $databaseUrl -notmatch "(@localhost:|@127\.0\.0\.1:|@host\.docker\.internal:)"
) {
    throw "Este script escribe datos de prueba. DATABASE_URL no parece local. Usa una BD local o ejecuta con -AllowNonLocalDatabase si estas completamente seguro."
}

function Post-Json {
    param(
        [string]$Url,
        [hashtable]$Body = @{}
    )

    $json = $Body | ConvertTo-Json -Depth 20

    return Invoke-RestMethod `
        -Uri $Url `
        -Method Post `
        -DisableKeepAlive `
        -TimeoutSec 180 `
        -ContentType "application/json" `
        -Body $json
}

function Get-Json {
    param([string]$Url)

    return Invoke-RestMethod `
        -Uri $Url `
        -DisableKeepAlive `
        -TimeoutSec 180 `
        -Method Get
}

function Print-EscalationSnapshot {
    param(
        [string]$Title,
        [object]$Escalation
    )

    Write-Host ""
    Write-Host "=== $Title ==="
    Write-Host "Status: $($Escalation.status)"
    Write-Host "Current level: $($Escalation.currentLevel)"
    Write-Host "Next escalation at: $($Escalation.nextEscalationAt)"

    $emailNotifications = @(
        $Escalation.notifications |
            Where-Object { $_.channel -eq "EMAIL" } |
            Sort-Object level, sentAt
    )

    if ($emailNotifications.Count -eq 0) {
        Write-Host "EMAIL notifications: none"
        return
    }

    Write-Host "EMAIL notifications:"
    $emailNotifications |
        Select-Object level, role, status, target, error, sentAt |
        Format-Table -AutoSize
}

function Ensure-TestRecipients {
    param([string]$Email)

    if (-not $Email) {
        return
    }

    $stamp = Get-Date -Format "yyyyMMddHHmmss"
    $roles = @("CHECKOUT_ENGINEER", "PAYMENTS_OPS", "ADMIN")

    foreach ($role in $roles) {
        Post-Json `
            "$BaseUrl/alerts/recipients" `
            @{
                name = "Email Flow Test $role $stamp"
                email = $Email
                role = $role
                merchants = @()
                providers = @()
                countries = @()
            } | Out-Null
    }

    Write-Host "Destinatarios de prueba creados para $Email."
}

function Invoke-NextEscalationTick {
    param([object]$Escalation)

    if (-not $Escalation.nextEscalationAt) {
        return $false
    }

    $dueAt = ([datetime]$Escalation.nextEscalationAt).AddSeconds(1).ToUniversalTime().ToString("o")
    Write-Host ""
    Write-Host "Tick simulado en $dueAt"

    Post-Json "$BaseUrl/alerts/escalations/tick?at=$dueAt" @{} |
        ConvertTo-Json -Depth 20

    return $true
}

function Get-ApiRoot {
    param([string]$Url)

    if ($Url.EndsWith("/api")) {
        return $Url.Substring(0, $Url.Length - 4)
    }

    return $Url.TrimEnd("/")
}

function Find-CheckoutEscalation {
    param([array]$DetectedIncidents)

    foreach ($incident in $DetectedIncidents) {
        $candidate = Get-Json "$BaseUrl/alerts/escalations/$($incident.incidentId)"
        if (
            $candidate -and
            $candidate.category -eq "DATA_QUALITY" -and
            @($candidate.routedRoles) -contains "CHECKOUT_ENGINEER"
        ) {
            return $candidate
        }
    }

    return $null
}

Write-Host ""
Write-Host "============================================"
Write-Host " ALERT EMAIL FLOW - 3 LEVELS"
Write-Host "============================================"
Write-Host "BaseUrl: $BaseUrl"
Write-Host ""

Write-Host "[1/6] Verificando API local..."
Get-Json "$(Get-ApiRoot $BaseUrl)/health" | ConvertTo-Json -Depth 5

Write-Host ""
Write-Host "[2/6] Sembrando politicas y directorio de alertas..."
if ($ResetDemoData) {
    Write-Host "ResetDemoData activo: regenerando historico sano local antes de probar."
    Invoke-RestMethod `
        -Uri "$BaseUrl/demo/seed?reset=true&historyHours=72&density=8" `
        -DisableKeepAlive `
        -TimeoutSec 180 `
        -Method Post |
        ConvertTo-Json -Depth 10
}

Post-Json "$BaseUrl/alerts/seed?resetRecipients=false" @{} |
    ConvertTo-Json -Depth 20

Ensure-TestRecipients $TargetEmail

Write-Host ""
Write-Host "[3/6] Preview del flujo de 3 niveles..."
$preview = Post-Json `
    "$BaseUrl/alerts/preview" `
    @{
        fingerprint = "country=MX|failureReason=INVALID_CVV|provider=Stripe"
        severity = 4
    }

$preview |
    ConvertTo-Json -Depth 20

if ($preview.levels.Count -lt 3) {
    throw "La politica seleccionada no tiene 3 niveles."
}

if (-not $IncidentId) {
    Write-Host ""
    Write-Host "[4/6] Inyectando incidente critico de checkout y corriendo deteccion..."

    Post-Json `
        "$BaseUrl/demo/inject-incident" `
        @{
            merchant = "PagoTotal Retail"
            provider = "Stripe"
            method = "CARD"
            country = "MX"
            issuingBank = "BBVA"
            approvalRate = 0.05
            durationMinutes = 15
            transactionsPerMinute = 80
            declineCode = "INVALID_CVV"
        } | ConvertTo-Json -Depth 10

    $detection = Post-Json `
        "$BaseUrl/detection/run" `
        @{
            windowMinutes = 15
            maxDepth = 5
            minSampleSize = 20
            minDrop = 0.05
            confirmationRuns = 1
        }

    $detection |
        ConvertTo-Json -Depth 20

    $detected = @($detection.incidents)
    if ($detected.Count -eq 0) {
        throw "Detection no devolvio incidentes. Revisa baselines/datos historicos antes de probar escalamiento."
    }

    $matchedEscalation = Find-CheckoutEscalation $detected
    if (-not $matchedEscalation) {
        $summary = $detected |
            Select-Object incidentId, fingerprint, anchorFingerprint, isNew |
            ConvertTo-Json -Depth 10

        throw "Detection creo incidentes, pero ninguno enruto como DATA_QUALITY/CHECKOUT_ENGINEER. Incidentes detectados: $summary"
    }

    $IncidentId = $matchedEscalation.incidentId
} else {
    Write-Host ""
    Write-Host "[4/6] Usando incidente existente: $IncidentId"
}

Write-Host ""
Write-Host "[5/6] Revisando nivel 1..."
$escalation = Get-Json "$BaseUrl/alerts/escalations/$IncidentId"
if (-not $escalation) {
    throw "El incidente $IncidentId no tiene escalamiento asociado."
}

if (
    $escalation.category -ne "DATA_QUALITY" -or
    -not (@($escalation.routedRoles) -contains "CHECKOUT_ENGINEER")
) {
    throw "El escalamiento real no coincide con el preview de checkout. Category=$($escalation.category); routedRoles=$($escalation.routedRoles -join ',')"
}

Print-EscalationSnapshot "Nivel 1 abierto" $escalation

Write-Host ""
Write-Host "[6/6] Avanzando a nivel 2 y nivel 3..."
for ($expectedLevel = 2; $expectedLevel -le 3; $expectedLevel++) {
    $advanced = Invoke-NextEscalationTick $escalation
    if (-not $advanced) {
        throw "No hay nextEscalationAt antes de llegar al nivel $expectedLevel."
    }

    $escalation = Get-Json "$BaseUrl/alerts/escalations/$IncidentId"
    Print-EscalationSnapshot "Nivel $expectedLevel disparado" $escalation
}

Write-Host ""
Write-Host "============================================"
Write-Host " EMAIL FLOW TEST COMPLETE"
Write-Host "============================================"
Write-Host "Incidente probado: $IncidentId"
Write-Host "Estados posibles por email: SENT si SMTP esta configurado, SKIPPED si falta SMTP, FAILED si el proveedor rechazo el envio."
