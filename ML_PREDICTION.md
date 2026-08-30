# Predictor de degradaciones — V2

Modelo preventivo de la Control Tower. Responde a una sola pregunta:

> ¿Esta ruta muestra señales precursoras de degradación en los próximos 15 minutos?

**No** clasifica códigos de rechazo, **no** crea incidentes y **no** llama a ningún LLM.

---

## 1. Prediction ≠ Detection ≠ Incident

| Módulo | Pregunta | Efecto |
|---|---|---|
| **Prediction** | "puede degradarse pronto" | devuelve un riesgo `LOW / WATCH / HIGH` |
| **Detection** | "la degradación ya está ocurriendo" | **único** que crea `Incident` |
| **Incident** | entidad persistida del problema real | dispara alertas y escalamiento |

Un `HIGH` predictivo **no** es un incidente. Esta separación es deliberada: el grafo y el Agent dependen del ciclo de vida de `Incident` y no deben ver predicciones ahí.

---

## 2. Documentación de Yuno utilizada

- Transaction status y response codes: <https://docs.y.uno/reference/payments/status-and-response-codes/transaction>
- Merchant Advice Codes: misma página, sección MAC
- Índice general: <https://docs.y.uno/llms.txt>

Todo lo transcrito de ahí está marcado como **OFICIAL** en `src/common/yuno-taxonomy.ts`.

### Transaction types (oficial)
`PURCHASE`, `AUTHORIZE`, `CAPTURE`, `REFUND`, `CANCEL`, `VERIFY`, `CHARGEBACK`, `THREE_D_SECURE`, `FRAUD_SCREENING`, `SPLIT_TRANSFER*`.

### Transaction statuses (oficial)
`SUCCEEDED`, `WON`, `CREATED`, `PENDING`, `DECLINED`, `REJECTED`, `ERROR`, `EXPIRED`, `LOST`, `PREVENTED`.

### Qué es un `response_code`
El código **normalizado por Yuno** que acompaña a cada transacción. No confundir con `provider_data.response_code`, que es el código **crudo del proveedor**. Guardamos los dos por separado: `responseCode` y `providerResponseCode`.

### Hard / Soft decline (oficial)
Publicado por Yuno código a código. Correcciones que V2 introduce respecto a V1:

| Código | V1 decía | Yuno publica |
|---|---|---|
| `EXPIRED` | HARD | **SOFT** (medio de pago alternativo vencido) |
| `INSUFFICIENT_FUNDS`, `DO_NOT_HONOR` | sin clasificar | **SOFT** |
| `BAD_FILLED_INFO`, `INVALID_PARAMETERS`, `INVALID_TRANSACTION`, `INVALID_API`, `INVALID_CREDENTIALS`, `TRANSACTION_NOT_FOUND`, `UNAVAILABLE_PAYMENT_METHOD`, `UNSUPPORTED_OPERATION`, `USER_RESTRICTION`, `RETRY_AFTER_*` | sin clasificar | **HARD** |
| `TERMINAL_ERROR`, `ACQUIRE_CONTINGENCY`, `REQUESTS_EXCEEDED` | sin clasificar | **SOFT** |

### `ERROR` y `REJECTED` tienen sus propias familias
- `ERROR`: `PROVIDER_TIMEOUT`, `PROVIDER_ERROR`, `PROVIDER_INTERNAL_ERROR`, `PROVIDER_INVALID_CREDENTIALS`, `OPERATION_NOT_SUPPORTED`, `TO_REVERSE`, …
- `REJECTED` (pre-proveedor, todos HARD): `COUNTRY_NOT_SUPPORTED`, `CURRENCY_NOT_ALLOWED`, `INVALID_PARAMETERS`, `INVALID_REQUEST`, `INTERNAL_ERROR`, `MISSING_PARAMETERS`.

> **Nota importante:** nuestro status canónico interno tiene `TIMEOUT`. Eso **no existe** en Yuno: un timeout es `status = ERROR` con `response_code = PROVIDER_TIMEOUT`. Se conserva porque Detection, Analytics y Alerts ya dependen de él; el mapeo está en `canonicalToYunoStatus` / `yunoStatusToCanonical`.

### Merchant Advice Code
Lista normalizada oficial. La agrupamos en `DO_NOT_RETRY` / `RETRY_LATER` / `UPDATE_INFORMATION` / `UNKNOWN`. La lista es oficial; **la agrupación es nuestra**.

---

## 3. Dominios lógicos de fallo — INFERENCIA NUESTRA

`PROVIDER`, `PROVIDER_CONFIGURATION`, `PRE_PROVIDER`, `ISSUER`, `AUTHENTICATION_3DS`, `FRAUD_SCREENING`, `MERCHANT_DATA`, `OTHER`, `UNKNOWN`.

**No son nombres de microservicios internos de Yuno.** La documentación pública describe etapas, proveedores, conexiones, antifraude, 3DS y routing, pero no publica topología interna. Son agrupaciones de producto nuestras, usadas para enrutar alertas y explicar incidentes.

Igual que `actionability` (`ACTIONABLE` / `ISSUER_SIDE` / `LIMITED` / `UNKNOWN`).

---

## 4. Contexto temporal: por qué y cómo

### Por qué no la hora cruda
La regresión logística es lineal en sus features. Con `hour = 23` y `hour = 0` el modelo entiende que están a 23 unidades de distancia, cuando operativamente son consecutivas. Aprendería un salto artificial a medianoche.

### Por qué seno **y** coseno
El seno solo no identifica la fase: `sin(03:00) == sin(09:00)`. Hacen falta las dos proyecciones para ubicar unívocamente un punto del ciclo de 24 h. Hay un test para cada mitad de esa afirmación.

### Fórmula exacta
```
local_minutes  = local_hour * 60 + local_minute
angle          = 2 * PI * local_minutes / 1440
local_time_sin = sin(angle)
local_time_cos = cos(angle)
```

Implementada dos veces, con el mismo texto: `src/common/local-time.ts` (Intl.DateTimeFormat) y `ml/local_time.py` (`zoneinfo`). Se usan nombres **IANA**, no offsets fijos, porque el offset no captura el horario de verano.

### Hora local, no UTC
El ancla es **el final de la ventana de observación** de la ruta evaluada, convertido a la zona local de esa ruta. No es la hora del servidor ni la hora de cada transacción.

### Cómo se determina la zona horaria — y su límite
`src/common/route-timezone.ts` resuelve en este orden: metadata explícita de la ruta → mapa país→IANA → `UTC`.

**Limitación que hay que decir en voz alta:** el modelo de datos solo tiene `country`, y **país no determina zona horaria de forma unívoca**. México y Brasil tienen varias. El mapa vale porque controlamos la geografía de la demo; no es una regla general. Los países ambiguos se marcan con `ambiguous: true` en la respuesta. La solución correcta en producción es guardar `timeZone` a nivel de ruta o conexión; la firma ya acepta ese override.

---

## 5. Causísticas sintéticas

Trece familias. La predictibilidad es **deliberadamente desigual**:

| Escenario | Precursor | Recall en test |
|---|---|---|
| `PROVIDER_TIMEOUT_DEGRADATION` | latencia sube antes | **1.000** |
| `PROVIDER_LATENCY_DEGRADATION` | latencia sube antes | **0.985** |
| `PROVIDER_RATE_LIMIT` | moderado | 0.619 |
| `ROUTING_FALLBACK_STRESS` | moderado | 0.598 |
| `AUTHENTICATION_3DS_DEGRADATION` | moderado | 0.548 |
| `ISSUER_DECLINE_SURGE` | débil | 0.406 |
| `PRE_PROVIDER_REJECTION_SURGE` | débil | 0.286 |
| `FRAUD_SCREENING_DEGRADATION` | débil | 0.263 |
| `MERCHANT_DATA_QUALITY_DEGRADATION` | débil | 0.228 |
| `PROVIDER_CONFIGURATION_FAILURE` | **ninguno** | 0.098 |
| `SUDDEN_FAILURE` | **ninguno** | 0.069 |
| `NORMAL` / `RECOVERY` | sin degradación | tasa de alerta 0.086 / 0.240 |

Que las credenciales inválidas y el fallo súbito tengan recall ~0.1 **es el resultado correcto**: no avisan antes de ocurrir. Un modelo que los "predijera" estaría leyendo una fuga del generador.

### Perfil diurno — SUPUESTO DE SIMULACIÓN
El dataset modela volumen bajo de madrugada, aprobación levemente menor de noche y latencia algo mayor. **Esto es una suposición nuestra, no un dato publicado por Yuno.** La documentación pública no describe curvas de aprobación nocturnas.

Los episodios se anclan en horas locales aleatorias sobre 24 h, 28 días y 5 zonas horarias (Bogotá, Ciudad de México, São Paulo, Lima, Madrid). Las degradaciones ocurren tanto de día como de noche.

### Diagnóstico de fuga temporal
Prevalencia del target por daypart: NIGHT 14.6 %, MORNING 14.5 %, AFTERNOON 15.1 %, EVENING 15.2 %. Rango entre la hora local mínima y máxima: 4.8 pp. Los escenarios están repartidos en los cuatro tramos. No hay fuga por hora.

---

## 6. Target

`will_degrade_within_15m`. Positivo **solo antes** de que la degradación real empiece. Las filas posteriores al fallo confirmado se eliminan del dataset (de 57 600 generadas quedan 40 450 usables). `scenario`, `daypart`, `local_hour` y `time_zone` viajan como metadata de evaluación, **nunca como features**.

---

## 7. Features V2 — 18 columnas

Orden congelado en `V2_FEATURES` (TypeScript) y `FEATURES` (Python). Un test compara ambos contra el artefacto.

| # | Feature | Familia |
|---|---|---|
| 1-2 | `local_time_sin`, `local_time_cos` | contexto temporal (un concepto lógico) |
| 3 | `baseline_approval_rate` | conversión |
| 4 | `approval_drop` | conversión |
| 5 | `approval_slope` | conversión |
| 6 | `p95_latency_ms` | rendimiento |
| 7 | `latency_slope` | rendimiento |
| 8 | `provider_error_rate` | salud del proveedor |
| 9 | `provider_timeout_rate` | salud del proveedor |
| 10 | `provider_failure_slope` | salud del proveedor |
| 11 | `rejected_rate` | pre-proveedor (Yuno) |
| 12 | `issuer_decline_rate` | origen del fallo |
| 13 | `auth_3ds_failure_rate` | origen del fallo |
| 14 | `fraud_screening_failure_rate` | origen del fallo |
| 15 | `data_quality_failure_rate` | origen del fallo |
| 16 | `provider_config_failure_rate` | origen del fallo |
| 17 | `hard_decline_share` | semántica de reintento |
| 18 | `retry_attempt_rate` | routing |

**Regla dura:** cada feature se calcula igual en Python y en PostgreSQL. Nada sintético que el runtime no pueda reproducir, y nada en runtime que el artefacto no entienda.

**Pendientes:** `(bucket_actual − bucket_más_antiguo) / 2` sobre 3 buckets de 5 min. Idéntica en ambos lados; hay test.

Se descartaron `soft_decline_rate` (complemento casi exacto de `hard_decline_share`) y `providers_attempted_per_payment` (el generador no produce pagos multi-proveedor de forma realista todavía). No se añadieron `day_of_week_sin/cos`: el dataset no modela diferencias semanales, así que serían ruido.

---

## 8. Baseline: por qué Prediction usa uno distinto

Se midió antes de decidir, como pedía el análisis.

**Opción A (baseline global de 24 h + sin/cos):** falsos positivos en tráfico sano → noche 0.197, día 0.120. **Delta +7.75 pp.** La noche sana alertaba sistemáticamente más. Los sin/cos no lo arreglan solos porque el modelo es lineal y no puede cancelar la interacción entre hora y caída de aprobación.

**Opción B (aplicada): baseline comparable por hora local.** Prediction compara la ventana actual contra las mismas horas locales de los últimos 7 días (±60 min por día). Resultado: noche 0.165, día 0.121, **delta +4.38 pp**.

Filtrando por evidencia suficiente (≥60 intentos): noche 0.143, día 0.105, **delta +3.83 pp**.

Los coeficientes temporales quedan casi en cero (`local_time_sin` +0.011, `local_time_cos` +0.001): tras condicionar el baseline, el modelo **dejó de usar la hora para decidir riesgo**, que es exactamente el objetivo — "¿son anormales las señales dado el contexto horario?", no "¿qué hora es?".

**Detection y el módulo Baselines NO cambian.** Siguen con su baseline segmentado por hora y día de semana. Solo Prediction usa el baseline comparable, y la respuesta lo declara en `baselineMode`.

**Se conserva la separación:** baseline histórico ≠ ventana reciente, con guard gap. La anomalía nunca contamina su propio baseline.

---

## 9. Evidencia

El volumen de intentos es **evidencia, no riesgo**. De madrugada el tráfico baja de forma legítima; eso no debe convertirse en "poco tráfico → riesgo alto". Se mantienen `currentAttempts`, `baselineAttempts`, `bucketAttempts` y `sufficientEvidence`, y devolver `INSUFFICIENT_EVIDENCE` es preferible a inventar un `HIGH`.

---

## 10. Threshold

**0.55**, elegido como el máximo F-beta(β=1.5) sobre **validation** sujeto a `precision ≥ 0.35`.

El piso de precisión no es cosmético: sin él, maximizar recall degeneraba en threshold 0.05 y tasa de alerta 1.0 incluso en tráfico sano. β=1.5 pondera recall por encima de precisión —un falso negativo cuesta un incidente no anticipado; un falso positivo cuesta una revisión— sin llegar a alertar de todo.

**No se tocó el test para elegirlo.** No se heredó el 0.15 de V1.

---

## 11. Métricas V2 (split de test, intacto)

| Métrica | Valor |
|---|---|
| ROC-AUC | 0.691 |
| ROC-AUC excluyendo lo no anticipable por diseño | **0.743** |
| Average Precision | 0.459 |
| Brier score | 0.197 |
| Precisión / Recall / F1 | 0.397 / 0.458 / 0.426 |
| Matriz de confusión | TN 5926 · FP 846 · FN 658 · TP 557 |

### Por daypart

| Daypart | n | prevalencia | precisión | recall | FPR | p media |
|---|---|---|---|---|---|---|
| NIGHT | 2099 | 0.140 | 0.348 | 0.522 | 0.159 | 0.454 |
| MORNING | 1963 | 0.144 | 0.354 | 0.440 | 0.134 | 0.440 |
| AFTERNOON | 1996 | 0.158 | 0.471 | 0.462 | 0.098 | 0.438 |
| EVENING | 1929 | 0.168 | 0.442 | 0.414 | 0.105 | 0.439 |

La probabilidad media es prácticamente plana entre tramos (0.438–0.454): el modelo no sube el riesgo por ser de noche.

Falsos positivos en tráfico sano por zona horaria: Bogotá 0.147, Lima 0.115, Ciudad de México 0.162, São Paulo 0.140, Madrid 0.141. Sin sesgo por zona.

---

## 12. SVM

**No se ejecutó el benchmark.** La regresión logística no mostró un problema no resuelto que lo justificara: el sesgo temporal se corrigió en el baseline, la calibración es utilizable y la interpretabilidad por coeficientes es un activo de la demo. Cambiar de modelo habría añadido riesgo de despliegue (semántica de probabilidad, calibración, inferencia en TypeScript) sin un problema concreto que resolver.

Queda como trabajo futuro con las condiciones ya escritas: mismos splits por episodio, mismo scaler ajustado solo en train, calibración separada del test, y sustitución solo ante una mejora material y repetible.

---

## 13. Paridad Python ↔ TypeScript

`ml/verify_prediction_v2.py` comprueba dos cosas y exporta los vectores:

1. el orden de features del artefacto coincide con `V2_FEATURES`;
2. el score (scaler → logit → sigmoide) coincide en ambos lados.

Resultado actual: **OK**, diferencia 0. Incluye la invariancia de fase: 02:00 en Bogotá y 02:00 en Madrid, con las mismas señales operativas, dan exactamente la misma probabilidad (delta 0.00e+00).

El test `src/modules/prediction/parity-v2.spec.ts` consume esos vectores, así que la paridad se verifica en cada `npm test`.

---

## 14. Artefacto

`ml/artifacts/failure_prediction_v2.json`, `modelVersion: 2.0.0`. Contiene features ordenadas, scaler, intercepto, coeficientes, threshold, horizonte, métricas por split/daypart/escenario, calibración, barrido de threshold y:

```json
"temporalContext": {
  "encoding": "LOCAL_TIME_SIN_COS",
  "periodMinutes": 1440,
  "timezoneSemantics": "route_local_time",
  "anchor": "final de la ventana de observacion reciente"
}
```

V1 se conserva en `failure_prediction_v1.json`. El runtime carga V2 si existe y cae a V1 si no.

---

## 15. API

Contratos preservados. Solo se **añaden** campos:

```
POST /api/predictions/segment
GET  /api/predictions/scan
POST /api/predictions/evaluate
```

`prediction` mantiene `model`, `predictionHorizonMinutes`, `failureProbability`, `failureProbabilityPercent`, `decisionThreshold`, `elevatedRisk`, `riskLevel`, `signals`. Nuevos en la respuesta de `segment`: `temporal`, `featureVectorV2`, `yunoFailureContext`, `baselineMode`.

`signals` son **contribuciones al logit**, no causas. Una feature que sube el logit no demuestra causalidad y no se llama "root cause".

`POST /predictions/evaluate` sigue aceptando el cuerpo de V1. Como ese DTO solo transporta 8 señales, las features que faltan se rellenan con la **media del scaler**: tras estandarizar valen 0 y no aportan al logit. Es un neutro explícito, no un cero disfrazado.

---

## 16. Cambios de Prisma

Estrictamente aditivos, migración `20260830120000_yuno_transaction_semantics`. Siete columnas opcionales en `Transaction`: `paymentId`, `attemptNumber`, `transactionType`, `yunoStatus`, `responseCode`, `merchantAdviceCode`, `providerResponseCode`, más tres índices.

`responseCode` es texto libre a propósito: un enum obligaría a migrar cada vez que Yuno publique un código nuevo.

`status`, `failureReason`, `declineCode` y `errorType` **no se tocan**. Detection, Analytics, Alerts y el Agent siguen igual. Ningún `migrate reset`, ningún borrado.

---

## 17. Limitaciones que quedan

1. **El delta noche/día no llegó a cero** (+3.8 pp con evidencia suficiente). Bajó de +7.75, los coeficientes temporales son ~0, pero queda un residuo asociado al perfil de latencia nocturna del generador.
2. **País → zona horaria es una aproximación.** Correcta para las rutas de la demo, no como regla general.
3. **El dataset es sintético.** Las distribuciones diurnas son supuestos nuestros, no comportamiento medido de Yuno.
4. **`providers_attempted_per_payment` no está.** Requiere pagos multi-proveedor realistas, que el generador aún no produce.
5. **Hay dos clasificadores de response codes** en el repo: este (`src/common/yuno-taxonomy.ts`, alineado con la tabla oficial) y `src/modules/agent/yuno-response-code.ts`, del Agent. No se tocó el del Agent para no romper su trabajo; conviene unificarlos después de la demo.
6. **El runtime no se probó contra base de datos real** en este entorno: no hay acceso a los engines de Prisma. Build y tests sí pasan.

---

## 18. Cómo ejecutarlo

```bash
# --- ML ---
pip install -r ml/requirements.txt
cd ml
python generate_dataset_v2.py     # dataset + diagnostico de fuga temporal
python train_model_v2.py          # entrena, evalua por daypart, exporta artefacto
python verify_prediction_v2.py    # paridad Python <-> TypeScript
cd ..

# --- Backend ---
npm install
npx prisma validate
npx prisma generate
npx prisma migrate deploy         # aplica 20260830120000_yuno_transaction_semantics
npm run build
npm test

# --- Demo ---
BASE=http://localhost:3000/api
curl -X POST "$BASE/demo/seed?reset=true&historyHours=36&density=6"
curl "$BASE/predictions/scan"
curl -X POST "$BASE/demo/inject-predictive-risk" -H 'Content-Type: application/json' \
  -d '{"merchant":"Nova Travel","provider":"dLocal","method":"CARD","country":"CO","issuingBank":"Bancolombia"}'
curl -X POST "$BASE/predictions/segment" -H 'Content-Type: application/json' \
  -d '{"provider":"dLocal","country":"CO"}'
curl "$BASE/predictions/scan"
```

En la respuesta de `segment` conviene mirar tres cosas: `evidence.sufficientEvidence`, `temporal` (hora local, daypart, si la zona es ambigua) y `yunoFailureContext` (distribución por status, dominio, HARD/SOFT y MAC).
