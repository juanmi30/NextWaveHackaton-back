# Control Tower — API y arquitectura del backend

NestJS · Prisma 7 · PostgreSQL · ESM. Monolito modular.

## Flujo

```
transacciones  ->  baselines      ->  deteccion        ->  incidentes
(ingesta+FX)       (esperado por      (recorrido de        (diagnostico
                    hora y dia)        dimensiones)         versionado)
```

## Modulos

| Modulo | Responsabilidad |
|---|---|
| `common/` | `dimensions.ts` (claves canonicas, combinaciones) y `stats.ts` (tasas, z-score, confianza) |
| `fx/` | Tasas por fecha, conversion a USD congelada en ingesta |
| `transactions/` | Ingesta, normalizacion y agregacion generica por N dimensiones |
| `baselines/` | Calculo del comportamiento esperado por segmento × hora × dia |
| `detection/` | Motor de deteccion y diagnostico, auditoria de corridas |
| `incidents/` | Lectura, historial de diagnosticos, reconocimiento de recurrencias |
| `analytics/` | Solo lectura: resumen, desglose y series para la UI |
| `demo/` | Seed de operacion normal e inyeccion de incidentes arbitrarios |

Cada modulo tiene `*.repository.ts` (acceso a datos), `*.service.ts` (logica),
`*.controller.ts` (HTTP) y `dto/` (validacion).

## Endpoints

Prefijo global `/api`, excepto `/health`.

### Salud
```
GET    /health
```

### Demo
```
POST   /api/demo/seed?reset=true&historyHours=36&density=6
POST   /api/demo/inject-incident
POST   /api/demo/reset
```

`inject-incident` acepta cualquier combinacion de `merchant`, `provider`,
`method`, `country`, `issuingBank`, mas `approvalRate`, `declineCode`,
`errorType`, `durationMinutes`, `transactionsPerMinute`. Es el endpoint de
la prueba de fuego: los jueces eligen la combinacion.

### Transacciones
```
POST   /api/transactions
POST   /api/transactions/bulk
GET    /api/transactions?provider=&country=&status=&from=&to=&limit=
GET    /api/transactions/count
```

### Baselines
```
POST   /api/baselines/rebuild        { lookbackHours, maxDepth, excludeLastMinutes }
GET    /api/baselines?dimensionKey=
GET    /api/baselines/count
```

### Deteccion
```
POST   /api/detection/run            { windowMinutes, maxDepth, minSampleSize,
                                       minZScore, minConfidence, minDrop }
GET    /api/detection/runs?limit=
GET    /api/detection/quiet-stats?hours=24
```

`quiet-stats` devuelve cuantas corridas terminaron sin alertar. Es la
evidencia de que el sistema vigila sin generar falsas alarmas.

`detection/run` incluye `slicesWithSample`, `slicesWithUsableBaseline`,
`slicesWithoutBaseline` y `slicesStatisticallyEvaluated`. Cuando no puede
evaluar el trafico contra historico responde `INSUFFICIENT_EVIDENCE` y agrega
`evidenceReason`; `NO_ANOMALY` implica que al menos un slice si fue evaluado.

Cuando una corrida crea un incidente nuevo, el backend intenta enviar alertas
por correo y WhatsApp si los canales estan configurados en variables de entorno.
La deteccion no falla si un canal externo no esta disponible.

### Incidentes
```
GET    /api/incidents?status=OPEN&minSeverity=&limit=
GET    /api/incidents/stats
GET    /api/incidents/:id
GET    /api/incidents/:id/history
PATCH  /api/incidents/:id/acknowledge
PATCH  /api/incidents/:id/resolve
```

El listado incluye el diagnostico vigente con sus filas de evidencia.
`/history` responde si el incidente es una recurrencia de uno ya resuelto.

### Alertas y escalamiento
```
POST   /api/alerts/seed?resetRecipients=false
GET    /api/alerts/recipients?includeInactive=false
POST   /api/alerts/recipients
DELETE /api/alerts/recipients/:id
GET    /api/alerts/policies
POST   /api/alerts/preview
GET    /api/alerts/escalations?status=PENDING&limit=50
GET    /api/alerts/escalations/:incidentId
POST   /api/alerts/escalations/tick?at=<iso>
POST   /api/alerts/escalations/:incidentId/acknowledge
```

Todas las politicas por defecto tienen tres niveles. Para severidad baja/media
(`standard`), el escalamiento es especialista (0 min), guardia de operaciones
(45 min) y administracion (120 min). El acuse desde `/incidents/:id/acknowledge`
tambien detiene la cadena de escalamiento.

### Analitica
```
GET    /api/analytics/summary?windowMinutes=60
GET    /api/analytics/breakdown?groupBy=provider&timeWindowMinutes=60
GET    /api/analytics/decline-reasons?provider=&country=&timeWindowMinutes=60
GET    /api/analytics/timeseries?minutes=120&bucketMinutes=5&provider=
```

`summary` devuelve `state`: `NORMAL` | `DEGRADED` | `INCIDENT`.

### FX
```
GET    /api/fx/rates
POST   /api/fx/rates/seed
```

### Payments Diagnostic Concierge
```
POST   /api/agent/incidents/:incidentId/analyze
POST   /api/agent/incidents/analyze-active
GET    /api/agent/incidents/:incidentId/analyze/stream
```

Analiza un incidente existente con el OpenAI Agents SDK y devuelve un diagnostico
JSON estructurado. Es read-only y nunca ejecuta
remediacion, rerouting ni cambios sobre el incidente. `OPENAI_MODEL` permite
seleccionar un modelo; si se omite, el SDK utiliza su modelo predeterminado.
Sin `OPENAI_API_KEY`, ante timeout (`AGENT_TIMEOUT_MS`, default 20000), error del
proveedor o salida invalida, devuelve un diagnostico determinista construido con
el Incident, su ultimo diagnostico/evidencia e historial almacenados.

La respuesta publica agrega `confidenceAnalysis`, `ruledOutHypotheses`,
`counterfactualImpact` y `diagnosisTrace`. Estos campos se calculan de forma
determinista despues de validar la salida del agente: usan exclusivamente el
Incident, su diagnosis/evidence persistida y los parametros de Detection. OpenAI
no calcula confidence explicable ni impacto contrafactual. Los controles sanos
solo descartan generalizaciones y el trace expone evidencia observable, no
razonamiento privado.

P5.2 agrega tambien `declineIntelligence` y `operationalOwnership`. Ambos se
derivan en backend desde `failureReason` y la taxonomia canonica de Yuno; el LLM
no clasifica codigos ni decide ownership. Si no existe `failureReason`,
`declineIntelligence` es `null` y ownership cae de forma segura en
`PAYMENTS_OPS`. Ninguna recomendacion ejecuta remediation.

Ejemplo aditivo para frontend:

```json
{
  "declineIntelligence": {
    "responseCode": "DO_NOT_HONOR",
    "transactionStatus": "DECLINED",
    "declineType": "SOFT",
    "failureDomain": "ISSUER",
    "actionability": "ISSUER_SIDE",
    "retryAdvice": "UNKNOWN",
    "unknownCode": false
  },
  "operationalOwnership": {
    "suspectedDomain": "ISSUER",
    "primaryTeam": "MERCHANT_SUCCESS",
    "supportingTeams": ["PAYMENTS_OPS"],
    "statement": "Evidence points to an issuer-side failure. Escalate issuer-specific evidence through the provider/acquirer path. No automatic remediation has been executed.",
    "basis": [
      "Canonical response code DO_NOT_HONOR maps to ISSUER.",
      "A supported root cause is present in the diagnosis."
    ],
    "requiresHumanApproval": true
  }
}
```

El endpoint `stream` usa SSE (`text/event-stream`) y emite solamente actividad
publica: `run_started`, `phase_changed`, `tool_started`, `tool_completed`,
`diagnosis`, `run_completed` o `error`. No expone argumentos/resultados de tools,
mensajes internos ni eventos raw del modelo.

`POST /api/agent/incidents/analyze-active` acepta un body opcional
`{ "limit": 10 }`. Lista incidentes `OPEN`, ejecuta un diagnostico independiente
por incidente con concurrencia limitada y devuelve prioridad operacional,
impacto economico agregado canonico y una correlacion conservadora. Un fallo
individual se reporta como `FAILED` sin descartar los demas resultados. El
agente multi-incidente diagnostica y prioriza; nunca remedia, modifica trafico,
acknowledge ni resuelve incidentes. El SSE multi-incidente queda pendiente; el
stream individual conserva su contrato actual.

### Live transaction monitoring

```text
POST   /api/live/start
POST   /api/live/stop
GET    /api/live/status
GET    /api/live/events                 # SSE
POST   /api/live/degradations
GET    /api/live/degradations
DELETE /api/live/degradations/:id
```

El monitor permanece `STOPPED` al iniciar NestJS. Requiere transacciones
historicas y baselines; si faltan responde `409 LIVE_MONITOR_NOT_READY`. Puede
usarse `{"autoSeed":true}` explicitamente, sin resetear datos existentes.

Ejemplo de inicio:

```json
{
  "tickIntervalMs": 1000,
  "transactionsPerTick": 50,
  "detectionIntervalMs": 5000,
  "detectionWindowMinutes": 5,
  "predictionEnabled": true,
  "predictionIntervalMs": 10000,
  "randomSeed": 1337
}
```

Prediction es early warning (`LOW`, `WATCH`, `HIGH`); Detection es la unica que
confirma anomalias y crea Incidents; Agent diagnostica, explica y prioriza, pero
nunca remedia. El status agrega `prediction` con enabled, interval, runs, skips,
estado in-flight, ultimo scan, conteos WATCH/HIGH y ultimo error, mas
`latestPredictiveRisks` limitado a los cinco riesgos mas importantes.
Detection publica `durationMs` por corrida y Live conserva
`detection.lastDurationMs` para observar el costo real sin modificar thresholds.

Las degradaciones son runtime-only y aceptan cualquier subconjunto de las
dimensiones de pagos. Las dimensiones omitidas son wildcards. Si varias reglas
coinciden, gana la mas especifica; en empate gana la menor `approvalRate`. Cada
regla genera tambien trafico dirigido, permitiendo combinaciones nunca vistas.

`/api/live/events` emite eventos agregados, nunca una transaccion por evento:
`monitor_started`, `monitor_stopped`, `transaction_batch`,
`degradation_started`, `degradation_expired`, `degradation_removed`,
`detection_started`, `detection_completed`, `detection_skipped`,
`incident_detected`, `prediction_started`, `prediction_completed`,
`prediction_skipped`, `predictive_risk_detected` y `heartbeat`.

#### LIVE DEMO FLOW

```bash
curl -X POST "$BASE/demo/seed?reset=true&historyHours=72&density=5"
curl -X POST "$BASE/live/start" -H 'Content-Type: application/json' -d '{}'
curl "$BASE/live/events"
curl -X POST "$BASE/live/degradations" -H 'Content-Type: application/json' \
  -d '{"dimensions":{"provider":"Adyen","country":"BR"},"approvalRate":0.35,"durationSeconds":60}'
curl "$BASE/live/status"
curl -X POST "$BASE/live/stop"
```

El monitor usa timers locales y debe ejecutarse con una sola replica durante el
hackathon. `LIVE_MONITOR_AUTO_START=false` es el default. No realiza routing,
remediation ni cleanup automatico de transacciones.
Al detenerse espera los runs in-flight de Detection/Prediction y elimina las
degradaciones runtime para que el siguiente demo comience limpio.

`POST /api/demo/seed?reset=true` es destructivo y exclusivo de demo: limpia
incidentes (incluyendo diagnoses/evidence), DetectionRun historicos,
transacciones y baselines antes de reconstruir una sesion reproducible.

## Guion de demo

```bash
BASE=https://tu-api.up.railway.app/api

# 1. Operacion normal
curl -X POST "$BASE/demo/seed?reset=true&historyHours=36&density=6"
curl -X POST "$BASE/detection/run" -H 'Content-Type: application/json' -d '{"windowMinutes":15}'
# -> NO_ANOMALY

# 2. Dos incidentes simultaneos
curl -X POST "$BASE/demo/inject-incident" -H 'Content-Type: application/json' \
  -d '{"provider":"Adyen","country":"BR","issuingBank":"Bradesco","approvalRate":0.38,"transactionsPerMinute":30}'
curl -X POST "$BASE/demo/inject-incident" -H 'Content-Type: application/json' \
  -d '{"provider":"Stripe","country":"MX","issuingBank":"BBVA","approvalRate":0.60,"transactionsPerMinute":30}'
curl -X POST "$BASE/detection/run" -H 'Content-Type: application/json' -d '{"windowMinutes":15}'
# -> INCIDENTS_FOUND, 2 incidentes separados y priorizados

# 3. Prueba de fuego: la combinacion la eligen los jueces
curl -X POST "$BASE/demo/inject-incident" -H 'Content-Type: application/json' \
  -d '{"merchant":"Nova Travel","method":"PSE","country":"CO","approvalRate":0.30}'
curl -X POST "$BASE/detection/run" -H 'Content-Type: application/json' -d '{"windowMinutes":12}'
```

## Decisiones y por que

### Calidad operacional de Detection

`POST /api/detection/run` aplica cuatro gates antes de considerar un slice:
muestra minima, drop absoluto, significancia estadistica y confianza. Las
anomalias moderadas requieren por defecto dos runs consecutivos con el mismo
`anchorFingerprint`; una anomalía severa puede confirmarse en el primer run.
`confirmationRuns` permite ajustar esa confirmacion.

El baseline se selecciona de forma jerarquica: segmento y franja temporal,
promedio horario, historico general, ancestors equivalentes y finalmente
platform. La respuesta de cada incidente incluye `baselineSource`, sample,
rate/variance, dimensiones coincidentes y profundidad de fallback.

Los incidentes activos se deduplican por anchor y cada refinamiento agrega una
version de diagnosis. La recuperacion requiere por defecto dos runs sanos
(`recoveryRuns`) o superar el timeout conservador existente. La prioridad es
determinista y economica: `lossPerMinuteCents` domina, seguida por severity,
confidence y lost approvals. Los campos nuevos son aditivos.

**Dimensiones desnormalizadas, sin catalogos con FK.** Una transaccion con un
banco emisor desconocido entraria en violacion de foreign key y el sistema se
quedaria ciego durante la prueba de fuego. En produccion, con catalogo estable,
se normalizaria y se validaria en el borde de ingesta.

**`failureReason` derivada en ingesta.** Unifica `declineCode` y `errorType` en
una sola dimension. Sin ella el detector no podria diagnosticar "el proveedor da
timeout": veria la caida sin la dimension que la explica.

**Los cuatro estados cuentan como intento.** Si `TIMEOUT` y `ERROR` se excluyen
del denominador, un proveedor colgado no baja la conversion, baja el volumen, y
el incidente se vuelve invisible.

**Baselines jerarquicos y temporales.** Se intenta segmento y franja exactos,
misma hora en otros dias, promedio del segmento, ancestors cada vez mas generales
y finalmente plataforma. La procedencia penaliza confidence cuando el fallback
es menos especifico.

**`amountUsdCents` congelado en ingesta ademas de `FxRate`.** Sumar centavos de
COP, MXN y BRL da un numero sin sentido. Guardar el valor convertido evita que
una fila de tasa faltante rompa la cifra de la vista ejecutiva en mitad de la demo.

**Poda por familias demostrables.** Una sola caida genera varias explicaciones.
Se fusionan cuando existe refinamiento padre-hijo o un candidato mas especifico
que conecta ambas; la mera ausencia de conflicto ya no fusiona incidentes.

**`anchorFingerprint` estable + `fingerprint` mutable.** El diagnostico se afina
sobre el mismo incidente en vez de duplicarlo, y el historial de versiones deja
mostrar en la demo como el sistema paso de una hipotesis gruesa a una precisa.
`anchorFingerprint` es inmutable durante toda la vida de la historia operacional,
tanto en refinamientos normales como al aislar una dimension nunca vista.

**Responsabilidades operacionales.** Prediction anticipa riesgo; Detection
confirma la anomalia; Incident conserva la historia operacional; Agent explica y
prioriza; Alerts notifica y escala a humanos en modo best-effort. Ninguna capa
ejecuta remediation, retries o rerouting automatico.

**`DetectionRun` registra tambien las corridas sin hallazgos.** Es la unica forma
de demostrar la ausencia de falsos positivos: sin ella solo se ve que no paso nada.

**Polling, no WebSockets.** El frontend consulta `/analytics/summary` y
`/incidents` cada pocos segundos. Es determinista, sobrevive a una reconexion en
mitad de la demo y no requiere infraestructura adicional.

## Limitaciones conocidas

- Un valor de dimension nunca visto puede evaluarse contra un ancestor o contra
  plataforma, pero esa evidencia reduce confidence y no demuestra por si sola
  que el valor nuevo sea la causa.
- `IncidentObservation` (serie temporal por incidente) no esta implementada: la
  grafica se deriva de `/analytics/timeseries` con las dimensiones del diagnostico.
