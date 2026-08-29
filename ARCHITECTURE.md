# ARCHITECTURE.md

## System

NextWave Hackathon backend is a NestJS modular monolith.

```text
Frontend
   |
   | REST
   v
NestJS API
   |
   +-- Transactions
   |
   +-- Analytics
   |
   +-- Incidents
   |
   +-- Demo
   |
   v
Prisma
   |
   v
PostgreSQL
```

## Core payment monitoring flow

```text
Payment transaction
       |
       v
Transaction ingestion
       |
       v
Transaction history
       |
       +-----------------------+
       |                       |
       v                       v
Historical baseline      Current window
       |                       |
       +-----------+-----------+
                   |
                   v
             Risk analysis
                   |
                   v
          Degradation detected?
              /          \
            no            yes
                           |
                           v
                       Incident
                           |
                           v
                 AI / operator action
```

## Module responsibilities

### transactions

Responsible for:

* payment transaction ingestion;
* bulk ingestion;
* querying transaction history.

It should not decide whether a route is risky.

### analytics

Responsible for:

* aggregating transaction metrics;
* comparing baseline vs current window;
* calculating degradation/risk;
* grouping by dimensions or payment route.

It should not manage incident lifecycle.

### incidents

Responsible for:

* persisting detected incidents;
* querying incidents;
* acknowledge;
* resolve.

It should not implement payment analytics.

### demo

Responsible for:

* deterministic hackathon demo data;
* creating known healthy/degraded scenarios.

It must never become part of production business logic.

## Design principles

1. Functional vertical slices.
2. Low coupling between modules.
3. Prisma is infrastructure, not domain logic.
4. Controllers remain thin.
5. Services contain application/domain behavior.
6. Avoid abstractions without an immediate use.
7. Optimize for a 24-hour hackathon.

## Future integration

Potential AI flow:

```text
Incident
   |
   v
Incident Context Builder
   |
   v
Payments Concierge
   |
   +--> explanation
   +--> recommended route
   +--> operator action
```

The LLM layer should operate on analytics produced by the backend.

Core degradation detection must remain deterministic.
