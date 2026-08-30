# Traspaso — Sistema de alertas y escalamiento

**Proyecto:** NextWave Hackathon 2026 · The Control Tower (Yuno × Nauta)
**Rama base:** `main` en `87f33bc`
**Estado:** compila, 67 tests en verde, migraciones aplicadas sobre base limpia.
**No está probado end-to-end contra base de datos real** — ver la sección 7.

---

## 1. Qué problema resuelve

El detector ya sabe **qué** está fallando y **por qué**. Lo que faltaba era **a
quién** avisar y **qué pasa si nadie contesta**.

Antes de este trabajo, `AlertsService.notifyIncidentCreated()` mandaba el mismo
correo y el mismo WhatsApp a una lista fija de direcciones sacadas de variables
de entorno, para cualquier incidente, sin importar la causa ni si alguien
respondía. Eso tiene dos fallos graves para una demo de operaciones de pagos:

1. Una alerta que le llega a todo el mundo termina ignorada por todo el mundo.
2. Si el destinatario está en una reunión, el incidente se queda sin dueño y
   nadie se entera.

El módulo nuevo resuelve las dos cosas: enrutamiento por competencia y
escalamiento por tiempo.

---

## 2. Integración (hacer esto primero)

```bash
git checkout -b feat/alert-escalation
# descomprimir el zip encima del repo

npx prisma generate          # obligatorio: hay modelos nuevos
npx prisma migrate deploy    # aplica 20260830000000_alert_escalation
npm run build
npm test                     # 67 tests

# arrancar y cargar el directorio
curl -X POST "$BASE/alerts/seed"
```

**Cero conflictos con `main`.** El último commit de main (`seed`) solo toca el
módulo demo, que este trabajo no modifica.

### Archivos que aporta

**13 nuevos:**

```
prisma/migrations/20260830000000_alert_escalation/migration.sql
src/modules/alerts/routing.ts                    # a quién le compete (puro)
src/modules/alerts/routing.spec.ts
src/modules/alerts/escalation-policy.ts          # niveles y tiempos (puro)
src/modules/alerts/escalation-policy.spec.ts
src/modules/alerts/escalation.service.ts         # máquina de estados
src/modules/alerts/escalation.service.spec.ts
src/modules/alerts/alerts.repository.ts          # acceso a datos
src/modules/alerts/alerts-directory.service.ts   # personas y políticas
src/modules/alerts/alerts.controller.ts
src/modules/alerts/dto/create-recipient.dto.ts
src/modules/alerts/dto/preview-routing.dto.ts
src/modules/alerts/dto/acknowledge-alert.dto.ts
```

**11 modificados**, de los cuales solo cuatro son código ajeno:

| Archivo | Cambio |
|---|---|
| `detection.service.ts` | `alerts.notifyIncidentCreated()` → `escalation.openForIncident()` |
| `incidents.service.ts` | `acknowledge()` y `resolve()` cierran la cadena de escalamiento |
| `incidents.module.ts` | importa `AlertsModule` |
| `incidents.controller.ts` | `PATCH /incidents/:id/acknowledge` acepta `{ recipientId }` |
| `app.module.ts` | registra `AlertsModule` |
| `alerts.service.ts` | de broadcast a entrega por destinatario |
| `alerts.module.ts` | registra los providers nuevos |
| `prisma/schema.prisma` | 5 modelos y 4 enums nuevos |
| `.gitignore` | añade `/.venv` |
| `API.md` | sección de escalamiento |
| `incidents.service.spec.ts` | stub del escalamiento en el constructor |

---

## 3. Arquitectura

```
detection.service
   └─ openForIncident()
        │
        ▼
escalation.service ─── routing.ts ────────► ¿a quién le compete?
   (máquina de       └─ escalation-policy.ts ► ¿en qué orden y cuándo?
    estados)
        │
        ├─ alerts.repository ──► Postgres
        └─ alerts.service ─────► correo / WhatsApp
```

**La separación es deliberada.** `routing.ts` y `escalation-policy.ts` son
funciones puras sin Prisma ni Nest: por eso se pueden testear de verdad y por
eso las 21 pruebas que las cubren corren en 20 ms. Toda la parte difícil de
razonar vive ahí; el servicio solo orquesta.

---

## 4. Decisiones de diseño (esto es lo que hay que poder defender)

### 4.1 El enrutamiento se decide por categoría de fallo, no por severidad

La severidad dice **cuánto corre prisa**, no **quién sabe arreglarlo**. Quien
sabe arreglarlo lo determina la categoría del `response_code`, resuelta con la
taxonomía de Yuno que ya vive en `src/common/payment-failure-taxonomy.ts`.

| Categoría | Rol |
|---|---|
| `DATA_QUALITY`, `AUTHENTICATION` | `CHECKOUT_ENGINEER` |
| `INTEGRATION` | `INTEGRATIONS_ENGINEER` |
| `PROVIDER_CONFIGURATION` | `INTEGRATIONS_ENGINEER` + `PROVIDER_MANAGER` |
| `FRAUD` | `RISK_ANALYST` |
| `CARD_EXPIRY`, `ISSUER_DECLINE` | `MERCHANT_SUCCESS` |
| `OTHER`, `UNKNOWN`, sin motivo concentrado | `PAYMENTS_OPS` |

Reutilizar la taxonomía en vez de inventar reglas nuevas es lo que mantiene el
sistema alineado con el vocabulario real de Yuno.

### 4.2 Un código desconocido nunca se pierde

El mentor dijo explícitamente que la lista de códigos está incompleta. Un
`response_code` que no esté en la taxonomía cae en `UNKNOWN` y va a la guardia
general. **Nunca se descarta un incidente por no reconocer el código.** Esto
también protege contra la prueba de fuego: si los jueces inyectan un código
inventado, el sistema avisa igual.

### 4.3 Los rechazos del emisor se marcan como no accionables

`DO_NOT_HONOR`, `INSUFFICIENT_FUNDS` y compañía son decisiones del banco. Llegan
a Merchant Success con el texto diciendo que no son accionables desde Yuno. Es
un aviso informativo, no una tarea. Alertar a un ingeniero por un
`INSUFFICIENT_FUNDS` es la vía más rápida a que ignore todas las alertas.

### 4.4 Si el fallo no se concentra en un motivo, es caída transversal

Cuando el diagnóstico no fija la dimensión `failureReason`, la degradación no
tiene una causa concentrada: es un proveedor caído o un país entero. Eso va
directo a la guardia general, no a un especialista.

### 4.5 Desde severidad 3 la guardia entra desde el primer aviso

Un especialista puede estar en una reunión; operaciones siempre está. Por debajo
de severidad 3 no se molesta a nadie más que al especialista.

### 4.6 El alcance filtra, pero es inclusivo a propósito

Cada persona tiene `merchants`, `providers`, `countries`. Vacío = cubre todo.

La regla es: **un destinatario queda fuera solo si el incidente fija una
dimensión que esa persona acota con otro valor.** Si el incidente no fija esa
dimensión, no se puede descartar que le afecte y se le notifica.

Trade-off consciente: en operaciones de pagos, un aviso de más cuesta una
lectura; uno de menos cuesta dinero durante todo el incidente.

### 4.7 Con la severidad cambian los tiempos, no los niveles

| Política | Severidad | Nivel 1 | Nivel 2 | Nivel 3 |
|---|---|---|---|---|
| `critical` | 4-5 | especialista + guardia (0 min) | administración (5 min) | todo el equipo (15 min) |
| `high` | 3 | especialista (0 min) | guardia (10 min) | administración (25 min) |
| `standard` | 0-2 | especialista (0 min) | guardia (45 min) | administración (120 min) |

Siempre se sube de menor a mayor: primero quien puede arreglarlo, luego quien
puede conseguir que alguien lo arregle, y al final quien responde por el
impacto.

### 4.8 Un canal caído no congela la cadena

Si SMTP o WhatsApp no están configurados, la notificación se registra como
`SKIPPED` y **el escalamiento sigue avanzando**. Durante la demo esto permite
ver la cadena completa sin depender de un servidor de correo.

### 4.9 El `tick` es un endpoint manual

`POST /api/alerts/escalations/tick?at=<iso>` avanza los escalamientos vencidos y
acepta una fecha simulada. Existe así a propósito: frente al jurado no se pueden
esperar cinco minutos reales, y un temporizador oculto no se puede enseñar.

### 4.10 Abrir la cadena es idempotente por incidente

El detector refina el diagnóstico varias veces sobre el mismo incidente. Eso no
debe reiniciar los relojes ni duplicar avisos, así que `openForIncident()` no
hace nada si ya existe un escalamiento para ese incidente.

---

## 5. Modelo de datos

```
EscalationPolicy ──< EscalationStep
       │
       └──< IncidentEscalation >── Incident        (1:1, unique en incidentId)
                   │      │
                   │      └── acknowledgedBy ──> Recipient
                   └──< AlertNotification ──> Recipient
```

**`Recipient`** — persona: `name`, `email`, `phone`, `role`, alcance
(`merchants` / `providers` / `countries` como `String[]`), `active`.

**`EscalationPolicy` + `EscalationStep`** — la política se elige por rango de
severidad. Cada paso tiene `level`, `waitMinutes`, `roles` fijos,
`includeSpecialists` (añade los roles derivados del diagnóstico) y `channels`.

**`IncidentEscalation`** — el estado vivo. Guarda `category`, `actionability`,
`routedRoles` y `routingReason`: **el porqué del enrutamiento se persiste**, no
solo el resultado. Eso permite defender la decisión después. Estados:
`PENDING` → `ACKNOWLEDGED` | `RESOLVED` | `EXHAUSTED`.

**`AlertNotification`** — bitácora de cada envío: nivel, rol, canal, estado
(`SENT`/`FAILED`/`SKIPPED`), destino y error. Es lo que la UI puede mostrar como
"quién fue avisado y cuándo".

`EXHAUSTED` significa que se agotaron todos los niveles sin respuesta. No es un
error: es información, y conviene que se vea en el dashboard.

---

## 6. API

```
POST   /api/alerts/seed?resetRecipients=false
GET    /api/alerts/recipients?includeInactive=false
POST   /api/alerts/recipients
DELETE /api/alerts/recipients/:id
GET    /api/alerts/policies

POST   /api/alerts/preview                       { fingerprint, severity }
GET    /api/alerts/escalations?status=PENDING&limit=50
GET    /api/alerts/escalations/:incidentId
POST   /api/alerts/escalations/tick?at=<iso>
POST   /api/alerts/escalations/:incidentId/acknowledge  { recipientId? }

PATCH  /api/incidents/:id/acknowledge            { recipientId? }   # también detiene la cadena
```

`POST /api/alerts/preview` es simulación sin efectos: responde a quién le
llegaría la alerta y en qué orden, sin provocar el incidente. Es el endpoint más
útil para enseñar el sistema.

### Variables de entorno

```
ALERT_APP_URL=                      # enlace al dashboard en el correo
ALERT_DELIVERY_TIMEOUT_MS=8000
EMAIL_ALERTS_ENABLED=true
SMTP_HOST= SMTP_PORT=587 SMTP_SECURE=false SMTP_USER= SMTP_PASS= SMTP_FROM=
WHATSAPP_ALERTS_ENABLED=true
WHATSAPP_TOKEN= WHATSAPP_PHONE_NUMBER_ID= WHATSAPP_GRAPH_API_VERSION=v22.0
```

`ALERT_EMAIL_TO` y `WHATSAPP_TO` **ya no se usan para enviar**. Solo los lee el
seed para rellenar los datos de contacto del equipo de ejemplo, para que las
alertas lleguen de verdad durante la demo sin tocar código.

---

## 7. Qué está verificado y qué NO

Esto es importante para que no se dé por bueno más de lo que se probó.

**Verificado:**

- `npm run build` limpio sobre el `main` actual.
- **67 tests en verde**, 31 nuevos:
  - `routing.spec.ts` (12): cada categoría a su rol, código desconocido a la
    guardia, emisor marcado como no accionable, filtrado por alcance, parseo del
    fingerprint.
  - `escalation-policy.spec.ts` (9): selección por severidad, cálculo de los
    vencimientos, agotamiento, tiempos monótonos.
  - `escalation.service.spec.ts` (10): la máquina de estados completa contra un
    repositorio en memoria — nivel 1 al especialista, no escala antes de tiempo,
    escala a administración, agota la política, el acuse detiene la cadena, no
    abre dos cadenas para el mismo incidente, respeta el alcance geográfico.
- Las tres migraciones aplican en orden sobre una base Postgres vacía (12 tablas).

**NO verificado:**

- **No se ejecutó contra base de datos real.** El entorno donde se escribió no
  puede descargar los engines de Prisma, así que no se pudo regenerar el cliente
  con los modelos nuevos ni levantar la app con el módulo activo.
- Por eso, en `alerts.repository.ts` los delegados de Prisma están **declarados a
  mano** (tipo `AlertsPrisma`). Esto permite compilar sin haber corrido
  `prisma generate`, pero significa que **el compilador no está validando esas
  consultas contra el esquema real**. Es el primer sitio donde buscar si algo
  falla en runtime.
- El envío real por SMTP y por la API de WhatsApp no se probó.

**Primera tarea recomendada:** correr `prisma generate`, levantar la app, hacer
el guion de demo de la sección 8 y confirmar que las consultas del repositorio
funcionan. Si algo falla, será ahí.

---

## 8. Guion de demo

```bash
BASE=https://tu-api.up.railway.app/api

curl -X POST "$BASE/alerts/seed"

# 1. Ver a quién le llegaría, sin provocar nada
curl -X POST "$BASE/alerts/preview" -H 'Content-Type: application/json' \
  -d '{"fingerprint":"country=BR|failureReason=INVALID_CREDENTIALS|provider=dLocal","severity":4}'

# 2. Incidente de checkout: solo se entera el equipo de checkout
curl -X POST "$BASE/demo/inject-incident" -H 'Content-Type: application/json' \
  -d '{"provider":"Stripe","country":"MX","declineCode":"INVALID_CVV","approvalRate":0.35}'
curl -X POST "$BASE/detection/run" -H 'Content-Type: application/json' -d '{"windowMinutes":15}'
curl "$BASE/alerts/escalations?status=PENDING"

# 3. Nadie responde -> sube a administración
curl -X POST "$BASE/alerts/escalations/tick?at=2026-08-30T18:06:00Z"

# 4. Alguien acusa recibo -> la cadena se detiene
curl -X POST "$BASE/alerts/escalations/<incidentId>/acknowledge" \
  -H 'Content-Type: application/json' -d '{"recipientId":"<id>"}'
curl -X POST "$BASE/alerts/escalations/tick"    # ya no escala
```

El contraste que vale la pena enseñar: inyectar `INVALID_CVV` y luego
`FRAUD_VALIDATION`, y ver que van a personas distintas sin haber tocado nada.

---

## 9. Trabajo pendiente, en orden de valor

1. **Validar contra base real** (sección 7). Bloqueante.
2. **Exponer el escalamiento en la UI.** El dato más vendible es la línea de
   tiempo: a quién se avisó, en qué nivel, cuánto tardó el acuse. `AlertNotification`
   ya tiene todo lo necesario.
3. **Botón de acuse de recibo en el dashboard**, que llame a
   `PATCH /incidents/:id/acknowledge` con el `recipientId`. Cierra el ciclo
   completo delante del jurado.
4. **Turnos / horarios (`OnCallSchedule`).** Hoy un rol está disponible siempre.
   Es la limitación más visible si un juez pregunta. Encaja sin tocar el resto
   del modelo: una tabla más y un filtro adicional en la selección de
   destinatarios.
5. **Enganchar el módulo de predicción.** Hoy solo se alerta sobre incidentes
   confirmados. `openForIncident()` recibe una estructura simple; un riesgo
   predicho podría abrir una cadena con severidad baja y política `standard`.
6. **Lock para el `tick`** si alguna vez corren varias instancias en Railway. Con
   una sola no hace falta.

---

## 10. Trampas conocidas del proyecto

Cosas que ya nos costaron tiempo y conviene no repetir:

- **Prisma 7**: la URL de conexión va en `prisma.config.ts`, no en
  `schema.prisma`. Y usar `process.env.DATABASE_URL ?? ''`, no el helper `env()`,
  porque `env()` revienta cuando la variable no está y `prisma generate` corre en
  `postinstall`.
- **No poner `NODE_ENV=production` en Railway.** Hace que `npm install` omita las
  devDependencies y el build muere con `nest: not found`.
- **Proyecto ESM**: todos los imports relativos llevan `.js` al final, incluso
  apuntando a archivos `.ts`.
- **`prisma/migrations/` tiene que estar commiteado.** Sin esa carpeta,
  `migrate deploy` no crea ninguna tabla y falla en silencio.
- **`.venv` pesa 333 MB.** Ya está en `.gitignore`, pero si alguien lo commiteó
  hay que sacarlo del historial con `git rm -r --cached .venv`.
