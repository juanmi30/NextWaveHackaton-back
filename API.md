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
```

Analiza un incidente existente con el OpenAI Agents SDK y devuelve un diagnostico
JSON estructurado. Es read-only, requiere `OPENAI_API_KEY` y nunca ejecuta
remediacion, rerouting ni cambios sobre el incidente. `OPENAI_MODEL` permite
seleccionar un modelo; si se omite, el SDK utiliza su modelo predeterminado.

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

**Baselines por hora del dia y dia de semana.** Comparar un domingo de madrugada
contra el promedio de la semana genera falsas alarmas garantizadas. El fallback
degrada a promedio del segmento cuando la franja exacta no tiene historico.

**`amountUsdCents` congelado en ingesta ademas de `FxRate`.** Sumar centavos de
COP, MXN y BRL da un numero sin sentido. Guardar el valor convertido evita que
una fila de tasa faltante rompa la cifra de la vista ejecutiva en mitad de la demo.

**Poda por cobertura, no por refinamiento.** Una sola caida genera decenas de
explicaciones ciertas ("bajo en Adyen", "bajo en CARD", "bajo en Brasil"). Se
conserva la mas especifica y se descartan las que podrian estar describiendo las
mismas transacciones; solo las mutuamente excluyentes se vuelven incidentes
aparte. Sin esto, dos incidentes reales aparecen como veinte.

**`anchorFingerprint` estable + `fingerprint` mutable.** El diagnostico se afina
sobre el mismo incidente en vez de duplicarlo, y el historial de versiones deja
mostrar en la demo como el sistema paso de una hipotesis gruesa a una precisa.

**`DetectionRun` registra tambien las corridas sin hallazgos.** Es la unica forma
de demostrar la ausencia de falsos positivos: sin ella solo se ve que no paso nada.

**Polling, no WebSockets.** El frontend consulta `/analytics/summary` y
`/incidents` cada pocos segundos. Es determinista, sobrevive a una reconexion en
mitad de la demo y no requiere infraestructura adicional.

## Limitaciones conocidas

- Un valor de dimension **nunca visto** no tiene baseline, asi que el diagnostico
  se ancla en la dimension padre que si lo tiene. Detecta, pero con menos
  especificidad. Reconstruir baselines tras la inyeccion lo resuelve.
- La poda por cobertura puede fusionar dos incidentes reales si ambos se explican
  solo a profundidad 1 y no comparten ninguna dimension en conflicto.
- `IncidentObservation` (serie temporal por incidente) no esta implementada: la
  grafica se deriva de `/analytics/timeseries` con las dimensiones del diagnostico.
