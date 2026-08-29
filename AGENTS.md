# NextWave Hackathon Backend — Codex Instructions

## Project goal

This repository contains the backend for the NextWave Hackathon 2026.

The product focuses on payment orchestration, transaction monitoring, payment degradation detection, incidents and AI-assisted payment operations.

The hackathon lasts 24 hours.

Primary engineering priority:

WORKING DEMO > architectural perfection > optional features.

Do not over-engineer.

---

## Stack

Backend:

* Node.js 22
* NestJS
* TypeScript
* Prisma
* PostgreSQL
* Railway

Frontend integration:

* React + Vite
* Vercel

Do not replace these technologies unless explicitly requested.

---

## Architecture

The backend is a modular monolith.

Current primary modules:

* transactions
* analytics
* incidents
* demo

Expected data flow:

Transaction
↓
Analytics
↓
Risk detection
↓
Incident
↓
AI / operator action

Maintain module boundaries.

Prefer:

Controller
↓
Service
↓
Prisma

Do not introduce repositories, CQRS, event buses, microservices or additional abstraction layers unless the task clearly requires them.

Hackathon simplicity is intentional.

---

## Existing domain

### Transaction

Represents a payment attempt.

Relevant dimensions may include:

* merchant
* provider
* payment method
* country
* bank
* status
* latency
* error type

Transaction status includes TIMEOUT where applicable.

### Analytics

Analyzes recent transaction behavior against a historical baseline.

Important signals include:

* approval rate
* approval rate drop
* failure rate
* failure trend
* latency
* transaction volume

The current analysis window MUST remain separate from the historical baseline.

Do not accidentally include current-window transactions inside the baseline.

### Incident

Represents a detected payment degradation.

Supported lifecycle:

OPEN
→ ACKNOWLEDGED
→ RESOLVED

Avoid introducing a more complicated incident workflow unless required.

---

## Current demo scenario

The repository contains deterministic demo data.

The demo intentionally produces degradation around a route similar to:

Nova Travel
→ dLocal
→ CARD
→ Colombia
→ Bancolombia

Typical demo behavior:

Historical approval rate ≈ healthy.
Current approval rate ≈ severe degradation.

The purpose is to guarantee a reproducible hackathon demo.

Do not remove deterministic demo behavior without explicit instruction.

---

## Development rules

Before modifying code:

1. Read this file.
2. Read `docs/ARCHITECTURE.md` if present.
3. Inspect the relevant module.
4. Inspect `prisma/schema.prisma` when touching persistence.
5. Inspect `package.json` before assuming a command or dependency exists.

When implementing:

* Prefer the smallest functional change.
* Reuse existing patterns.
* Keep services reasonably small.
* Keep business logic out of controllers.
* Use DTOs for HTTP input where appropriate.
* Preserve Prisma as the persistence layer.
* Avoid duplicated domain logic.
* Avoid speculative abstractions.
* Avoid adding dependencies unless they materially simplify the requested task.
* Do not rewrite working modules simply to improve style.

---

## Database rules

Prisma is the source of truth for the database model.

Important:

* Prisma configuration follows the current Prisma 7 setup in this repository.
* DATABASE_URL configuration must remain compatible with Railway.
* Do not revert the deployment fixes already present in the project.
* Do not migrate back to TypeORM.

When changing the schema:

1. Update `prisma/schema.prisma`.
2. Make the minimum necessary model change.
3. Update affected services and DTOs.
4. Validate Prisma.
5. Clearly state whether a migration is required.

Never silently delete existing fields.

---

## Deployment rules

Railway deployment compatibility is critical.

Do not undo:

* Node 22 compatibility.
* Nest CLI/build dependency fixes.
* Prisma 7 configuration fixes.
* production TypeScript configuration.
* Railway DATABASE_URL handling.

A feature that works locally but breaks deployment is not complete.

---

## API rules

Prefer REST endpoints under:

/api/...

Existing domain conventions should be preserved.

Examples:

POST /api/transactions
POST /api/transactions/bulk
GET  /api/transactions

GET  /api/analytics/risk
POST /api/analytics/detect

GET   /api/incidents
PATCH /api/incidents/:id/acknowledge
PATCH /api/incidents/:id/resolve

POST /api/demo/seed

When changing an API contract:

* state the old contract if relevant;
* state the new contract;
* mention frontend impact.

Avoid breaking existing endpoints unnecessarily.

---

## AI features

AI should add product value, not architectural complexity.

Good AI use cases:

* explain why payment performance degraded;
* summarize an incident;
* recommend routing changes;
* Payments Concierge interaction;
* convert analytics into operator actions.

AI must consume deterministic structured backend data whenever possible.

Do not make the core payment monitoring workflow depend entirely on an LLM.

The system should still detect incidents if AI is unavailable.

---

## Task workflow

For every non-trivial task:

### 1. Inspect

Identify:

* relevant modules;
* relevant schema;
* existing implementation;
* API impact.

Do not modify code before understanding the existing implementation.

### 2. Plan

Provide a short implementation plan.

Maximum approximately 3–6 steps.

Do not produce long architecture essays unless requested.

### 3. Implement

Make the smallest coherent patch.

Prefer working code over generalized frameworks.

### 4. Validate

Run applicable existing checks.

At minimum when available:

* Prisma validation if schema changed;
* TypeScript/Nest build;
* relevant tests if they exist.

Do not claim a command passed unless it actually ran successfully.

### 5. Report

At the end state:

* what changed;
* files changed;
* API changes;
* database changes;
* validation performed;
* anything still blocking the feature.

Keep the summary concise.

---

## Debugging workflow

When asked to fix an error:

1. Reproduce or inspect the exact error.
2. Identify root cause.
3. Apply the smallest fix.
4. Validate it.
5. Explain the root cause in 1–3 sentences.

Do not redesign unrelated parts of the application while debugging.

---

## Hackathon priorities

Priority order:

P0 — application builds and deploys
P0 — demo flow works
P0 — frontend can consume backend
P1 — transaction monitoring
P1 — risk detection
P1 — incidents
P1 — AI concierge / explanation
P2 — UX-supporting APIs
P3 — optimization and refactoring

When choosing between:

robust but incomplete

and

simple but demonstrable

prefer simple but demonstrable.

---

## Guardrails

Do NOT:

* replace NestJS;
* replace Prisma;
* replace PostgreSQL;
* migrate to microservices;
* introduce Kafka/RabbitMQ without a concrete requirement;
* introduce Redis without a concrete requirement;
* create generic abstraction frameworks;
* remove the deterministic demo seed;
* modify deployment configuration casually;
* reformat the entire repository for a small feature;
* touch unrelated modules unless necessary.

---

## Definition of done

A task is complete when:

1. requested behavior exists;
2. existing behavior is preserved unless explicitly changed;
3. affected code compiles;
4. persistence changes are consistent with Prisma;
5. API impact is documented;
6. the implementation remains deployable to Railway;
7. Codex reports exactly what it changed.

For hackathon features, the final question should always be:

"Can we demonstrate this from the frontend right now?"

If not, identify the smallest remaining blocker.
