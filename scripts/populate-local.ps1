# ============================================================
# CONTROL TOWER - POPULATE LOCAL DATABASE
# ============================================================
# SOLO PARA BD LOCAL.
# Este script hace RESET de los datos demo.
#
# Deja:
# - histórico sano
# - baselines
# - corrida sana de detection
# - casos predictivos recientes
# - múltiples incidentes confirmados
# - incidentes OPEN
# - un incidente ACKNOWLEDGED
# - un incidente RESOLVED
# - una recurrencia
# ============================================================

$ErrorActionPreference = "Stop"

$BASE = "http://localhost:3000/api"

Write-Host ""
Write-Host "============================================"
Write-Host " CONTROL TOWER - LOCAL DATA POPULATION"
Write-Host "============================================"
Write-Host ""


# ------------------------------------------------------------
# Helper
# ------------------------------------------------------------

function Post-Json {
    param(
        [string]$Url,
        [hashtable]$Body
    )

    $json = $Body | ConvertTo-Json -Depth 10

    return Invoke-RestMethod `
        -Uri $Url `
        -Method Post `
        -ContentType "application/json" `
        -Body $json
}


# ============================================================
# 1. RESET + HEALTHY SEED
# ============================================================

Write-Host "[1/9] Reset + healthy seed..."

$seed = Invoke-RestMethod `
    -Uri "$BASE/demo/seed?reset=true&historyHours=72&density=8" `
    -Method Post

$seed | ConvertTo-Json -Depth 10

Write-Host ""
Write-Host "Seed completado."
Write-Host ""


# ============================================================
# 2. HEALTHY DETECTION RUN
# ============================================================

Write-Host "[2/9] Running healthy detection..."

$healthyDetection = Post-Json `
    "$BASE/detection/run" `
    @{
        windowMinutes = 15
    }

$healthyDetection | ConvertTo-Json -Depth 10

Write-Host ""
Write-Host "Esperado: NO_ANOMALY."
Write-Host ""


# ============================================================
# 3. PREDICTIVE CASE #1
# Nova Travel / dLocal / Colombia
# ============================================================

Write-Host "[3/9] Injecting predictive case #1..."

$predictive1 = @{
    merchant = "Nova Travel"
    provider = "dLocal"
    method = "CARD"
    country = "CO"
    issuingBank = "Bancolombia"
    transactionsPerMinute = 12
}

$p1 = Post-Json `
    "$BASE/demo/inject-predictive-risk" `
    $predictive1

$p1 | ConvertTo-Json -Depth 10


# ============================================================
# 4. PREDICTIVE CASE #2
# PagoTotal / Stripe / Mexico
# ============================================================

Write-Host ""
Write-Host "[4/9] Injecting predictive case #2..."

$predictive2 = @{
    merchant = "PagoTotal Retail"
    provider = "Stripe"
    method = "CARD"
    country = "MX"
    issuingBank = "BBVA"
    transactionsPerMinute = 12
}

$p2 = Post-Json `
    "$BASE/demo/inject-predictive-risk" `
    $predictive2

$p2 | ConvertTo-Json -Depth 10


# IMPORTANTE:
# escanear inmediatamente porque Prediction usa ventana reciente.

Write-Host ""
Write-Host "Scanning predictive risks..."

$predictionScan = Invoke-RestMethod `
    -Uri "$BASE/predictions/scan" `
    -Method Get

$predictionScan |
    ConvertTo-Json -Depth 20


# ============================================================
# 5. CONFIRMED INCIDENT #1
# Provider / BR / Adyen
# ============================================================

Write-Host ""
Write-Host "[5/9] Injecting confirmed incident #1..."

$incident1Body = @{
    merchant = "Mercado Uno"
    provider = "Adyen"
    method = "CARD"
    country = "BR"
    issuingBank = "Bradesco"

    approvalRate = 0.30
    durationMinutes = 15
    transactionsPerMinute = 30

    declineCode = "DECLINED_BY_PROVIDER"
    errorType = "PROVIDER_TIMEOUT"
}

$i1Injection = Post-Json `
    "$BASE/demo/inject-incident" `
    $incident1Body

$i1Injection |
    ConvertTo-Json -Depth 10


# ============================================================
# 6. CONFIRMED INCIDENT #2
# Stripe / MX / BBVA
# ============================================================

Write-Host ""
Write-Host "[6/9] Injecting confirmed incident #2..."

$incident2Body = @{
    merchant = "PagoTotal Retail"
    provider = "Stripe"
    method = "CARD"
    country = "MX"
    issuingBank = "BBVA"

    approvalRate = 0.42
    durationMinutes = 15
    transactionsPerMinute = 30

    declineCode = "DO_NOT_HONOR"
    errorType = "PROVIDER_ERROR"
}

$i2Injection = Post-Json `
    "$BASE/demo/inject-incident" `
    $incident2Body

$i2Injection |
    ConvertTo-Json -Depth 10


# ============================================================
# 7. CONFIRMED INCIDENT #3
# dLocal / CO / Bancolombia
# ============================================================

Write-Host ""
Write-Host "[7/9] Injecting confirmed incident #3..."

$incident3Body = @{
    merchant = "Nova Travel"
    provider = "dLocal"
    method = "CARD"
    country = "CO"
    issuingBank = "Bancolombia"

    approvalRate = 0.25
    durationMinutes = 15
    transactionsPerMinute = 30

    declineCode = "REQUESTS_EXCEEDED"
    errorType = "TERMINAL_ERROR"
}

$i3Injection = Post-Json `
    "$BASE/demo/inject-incident" `
    $incident3Body

$i3Injection |
    ConvertTo-Json -Depth 10


# ============================================================
# 8. RUN DETECTION
# Este paso CREA los Incident reales.
# ============================================================

Write-Host ""
Write-Host "[8/9] Running detection over all injected failures..."

$detection = Post-Json `
    "$BASE/detection/run" `
    @{
        windowMinutes = 15
        maxDepth = 3
        minSampleSize = 20
    }

$detection |
    ConvertTo-Json -Depth 20


# Guardamos IDs detectados.

$incidentIds = @(
    $detection.incidents |
        ForEach-Object {
            $_.incidentId
        }
)

Write-Host ""
Write-Host "Incident IDs detected:"
$incidentIds | ForEach-Object {
    Write-Host " - $_"
}


# ============================================================
# 9. CREATE DIFFERENT LIFECYCLE STATES
# ============================================================

Write-Host ""
Write-Host "[9/9] Creating incident lifecycle variety..."

# Dejamos el primero OPEN.
#
# Acknowledge del segundo.
if ($incidentIds.Count -ge 2) {

    Write-Host "Acknowledging incident #2..."

    Invoke-RestMethod `
        -Uri "$BASE/incidents/$($incidentIds[1])/acknowledge" `
        -Method Patch `
        -ContentType "application/json" `
        -Body "{}" |
        ConvertTo-Json -Depth 10
}

# Resolve del tercero.
if ($incidentIds.Count -ge 3) {

    Write-Host ""
    Write-Host "Resolving incident #3..."

    Invoke-RestMethod `
        -Uri "$BASE/incidents/$($incidentIds[2])/resolve" `
        -Method Patch |
        ConvertTo-Json -Depth 10
}


# ============================================================
# FINAL CHECKS
# ============================================================

Write-Host ""
Write-Host "============================================"
Write-Host " FINAL DATABASE STATE"
Write-Host "============================================"


Write-Host ""
Write-Host "--- INCIDENT STATS ---"

Invoke-RestMethod `
    -Uri "$BASE/incidents/stats" `
    -Method Get |
    ConvertTo-Json -Depth 20


Write-Host ""
Write-Host "--- ALL INCIDENTS ---"

$allIncidents = Invoke-RestMethod `
    -Uri "$BASE/incidents?limit=50" `
    -Method Get

$allIncidents |
    ConvertTo-Json -Depth 30


Write-Host ""
Write-Host "--- ANALYTICS SUMMARY ---"

Invoke-RestMethod `
    -Uri "$BASE/analytics/summary?windowMinutes=60" `
    -Method Get |
    ConvertTo-Json -Depth 20


Write-Host ""
Write-Host "--- PROVIDER BREAKDOWN ---"

Invoke-RestMethod `
    -Uri "$BASE/analytics/breakdown?groupBy=provider&timeWindowMinutes=60" `
    -Method Get |
    ConvertTo-Json -Depth 20


Write-Host ""
Write-Host "--- PREDICTION SCAN ---"

Invoke-RestMethod `
    -Uri "$BASE/predictions/scan" `
    -Method Get |
    ConvertTo-Json -Depth 20


Write-Host ""
Write-Host "============================================"
Write-Host " POPULATION COMPLETE"
Write-Host "============================================"