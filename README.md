# Kontrora: Revenue & Billing (Estimates & Line Items)

> Staff Engineer Assignment

An enterprise-grade, multi-tenant **Professional Services Automation (PSA)** platform built with **Next.js (App Router)**, **TypeScript**, and **Supabase (PostgreSQL + RLS)**.

This repository implements the **Revenue & Billing: Estimates & Line Items** slice end to end, with:

- Mathematically correct money handling
- Multi-tenant security boundaries
- Idempotent mutation APIs
- A strict lifecycle state machine
- RBAC enforcement
- An interactive UI

---

## Table of Contents

1. [Architecture Decisions](#1-architecture-decisions)
2. [Database Schema & Tenancy](#2-database-schema--tenancy)
3. [RBAC & Security Review](#3-rbac--security-review)
4. [API Specification](#4-api-specification)
5. [UI Components](#5-ui-components)
6. [Running Tests](#6-running-tests)
7. [Local Setup Guide](#7-local-setup-guide)
8. [What We Would Ship Next (Staff Roadmap)](#8-what-we-would-ship-next-staff-roadmap)

---

## 1. Architecture Decisions

### 1.1 Minor Units (Cents / BIGINT) for All Monetary Values

Floating-point arithmetic (IEEE-754) is prone to binary rounding drift:

```js
0.1 + 0.2 === 0.30000000000000004
```

In billing software, this causes penny discrepancies, reconciliation failures, and audit headaches.

| Aspect | Decision |
|---|---|
| **Storage** | All monetary fields (`subtotal_cents`, `tax_cents`, `total_cents`, `unit_price_cents`, `amount_cents`) are stored as `BIGINT` |
| **Backend** | Services operate strictly on integer minor units |
| **Presentation** | Formatting happens only in the UI via `Intl.NumberFormat` |
| **API** | Submissions and DB calculations use minor units only |

### 1.2 Defense-in-Depth Multi-Tenancy

Tenant isolation never relies on a single layer. It is enforced at three independent boundaries:

| # | Layer | Mechanism | Purpose |
|---|---|---|---|
| 1 | **Database trigger** | `check_estimate_project_account` | Ensures a linked `project_id` belongs to the same `account_id`, making cross-tenant project spoofing impossible at the DB level |
| 2 | **Row Level Security** | Policies based on `auth.uid()` | Account-level reads for account managers, members, and client users |
| 3 | **Application guard** | `requireAuthAndPermission` | Every API route validates account membership/management before any query |

### 1.3 Idempotency via SHA-256 Request Fingerprinting

Network failures cause clients to retry money-touching operations such as `POST /api/accounts/[accountId]/estimates`. Without idempotency, retries can duplicate estimates or billing records.

- Supports the standard `Idempotency-Key` header (or `X-Idempotency-Key`).
- Cached responses are stored in `idempotency_records` alongside a SHA-256 hash of the payload.

| Scenario | Result |
|---|---|
| Same key, same payload | Cached `201` replayed with header `Idempotent-Replay: true` |
| Same key, different payload | `409 Conflict` |

### 1.4 Finite State Machine & Immutability

Estimates follow a strict, unidirectional state machine:

```text
  [ draft ] ───────────► [ sent ] ───────────► [ accepted ]  (terminal, immutable)
      │                     │
      ▼                     ▼
  [ rejected ]          [ rejected ]                         (terminal, immutable)
```

| State | Editable? | Notes |
|---|---|---|
| `draft` | Yes | Only state where line items, quantities, and prices can change |
| `sent` | No | Terms are locked |
| `accepted` | No | Permanently immutable; cannot be deleted |
| `rejected` | No | Permanently immutable |

The database trigger `check_estimate_immutability` enforces this even against direct SQL updates.

### 1.5 Soft Deletion (`deleted_at`)

Financial records are never hard-deleted in production, for regulatory and audit compliance.

- Every estimate has `deleted_at TIMESTAMPTZ DEFAULT NULL`.
- Queries filter with `WHERE deleted_at IS NULL`.
- `DELETE` endpoints set `deleted_at = NOW()`.
- Estimates in `accepted` status **cannot** be deleted under any circumstances.

---

## 2. Database Schema & Tenancy

The migration file is [`supabase/estimates.sql`](supabase/estimates.sql).

### 2.1 `estimates` Table

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | PK, default `gen_random_uuid()` | Estimate identifier |
| `account_id` | `UUID` | NOT NULL, FK `accounts(id)` ON DELETE RESTRICT | Tenancy anchor |
| `project_id` | `UUID` | FK `projects(id)` ON DELETE SET NULL | Optional project link |
| `estimate_number` | `TEXT` | NOT NULL, unique per account | Human-readable ID (`EST-YYYY-XXXX`) |
| `title` | `TEXT` | NOT NULL | Proposal title |
| `description` | `TEXT` | NULLABLE | Scope summary |
| `status` | `TEXT` | NOT NULL, CHECK in (`draft`, `sent`, `accepted`, `rejected`) | Lifecycle stage |
| `currency` | `TEXT` | NOT NULL, default `'USD'` | ISO 4217 3-letter code |
| `subtotal_cents` | `BIGINT` | NOT NULL, CHECK `>= 0` | Sum of line items (minor units) |
| `tax_cents` | `BIGINT` | NOT NULL, CHECK `>= 0` | Tax (minor units) |
| `total_cents` | `BIGINT` | NOT NULL, CHECK `>= 0` | Subtotal + tax |
| `idempotency_key` | `TEXT` | NULLABLE, unique per account | Deduplication key |
| `valid_until` | `DATE` | NULLABLE | Expiration date |
| `notes` | `TEXT` | NULLABLE | Commercial terms |
| `created_by` | `UUID` | FK `user_profiles(id)` | Author audit trail |
| `sent_at` | `TIMESTAMPTZ` | NULLABLE | When sent to client |
| `accepted_at` | `TIMESTAMPTZ` | NULLABLE | When approved by client |
| `rejected_at` | `TIMESTAMPTZ` | NULLABLE | When declined |
| `deleted_at` | `TIMESTAMPTZ` | NULLABLE | Soft-deletion flag |
| `created_at` | `TIMESTAMPTZ` | default `NOW()` | Creation timestamp |
| `updated_at` | `TIMESTAMPTZ` | default `NOW()` | Auto-updated via trigger |

### 2.2 `estimate_line_items` Table

| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | PK | Item identifier |
| `estimate_id` | `UUID` | NOT NULL, FK `estimates(id)` ON DELETE CASCADE | Parent estimate |
| `description` | `TEXT` | NOT NULL | Deliverable description |
| `quantity` | `NUMERIC(10,2)` | NOT NULL, CHECK `> 0` | Hours or item count |
| `unit_price_cents` | `BIGINT` | NOT NULL, CHECK `>= 0` | Rate in minor units |
| `amount_cents` | `BIGINT` | NOT NULL, CHECK `>= 0` | `ROUND(quantity * unit_price_cents)` |
| `order_index` | `INTEGER` | NOT NULL, default `0` | Display ordering |

### 2.3 `idempotency_records` Table

Stores idempotency keys, SHA-256 payload hashes, status codes, and JSON response bodies, with an automatic **24-hour** expiration window.

---

## 3. RBAC & Security Review

### 3.1 Permission Additions

Defined in [`lib/permissions.ts`](lib/permissions.ts):

| Permission | Value | Purpose |
|---|---|---|
| `Permission.VIEW_ESTIMATES` | `view_estimates` | View proposals scoped to accounts the user can access |
| `Permission.MANAGE_ESTIMATES` | `manage_estimates` | Create drafts, update line items, transition lifecycle states |
| `Permission.VIEW_ALL_ESTIMATES` | `view_all_estimates` | Executive override: view estimates org-wide |
| `Permission.MANAGE_ALL_ESTIMATES` | `manage_all_estimates` | Executive override: manage estimates org-wide |

### 3.2 Role Mappings

Defined in [`supabase/seed-roles.sql`](supabase/seed-roles.sql):

| Role | Access | Scope |
|---|---|---|
| **Superadmin** | Full bypass across all routes | Global |
| **Executive Director** | `view_all_estimates: true` | Org-wide financial visibility |
| **Account Manager** | `view_estimates: true`, `manage_estimates: true` | Their accounts |
| **Project Manager** | `view_estimates: true` | Projects within their assigned accounts |
| **Client** | `view_estimates: true` | Strictly their `client_account_id` |

### 3.3 Route Guard Enforcement

Every route uses `requireAuthAndPermission`:

```typescript
await requireAuthAndPermission(Permission.VIEW_ESTIMATES, { accountId }, request);
```

If an attacker supplies another account's UUID or an invalid ID, the request is stopped at the perimeter with `403 Forbidden` or `400 Bad Request`.

---

## 4. API Specification

All routes are nested under `/api/accounts/[accountId]/estimates`.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/accounts/[accountId]/estimates` | List & filter estimates |
| `POST` | `/api/accounts/[accountId]/estimates` | Create estimate (idempotent) |
| `GET` | `/api/accounts/[accountId]/estimates/[id]` | Get estimate by ID |
| `PATCH` | `/api/accounts/[accountId]/estimates/[id]` | Update draft / transition lifecycle |
| `DELETE` | `/api/accounts/[accountId]/estimates/[id]` | Soft-delete estimate |

### 4.1 List & Filter Estimates

`GET /api/accounts/[accountId]/estimates`

**Query parameters**

| Param | Description | Default |
|---|---|---|
| `status` | Filter by `draft`, `sent`, `accepted`, `rejected` | None |
| `project_id` | Filter by associated project | None |
| `search` | Case-insensitive search on title and estimate number | None |
| `page` | Page number | `1` |
| `limit` | Page size (max `100`) | `20` |

**Response:** paginated estimates list plus financial metrics: `total_value_cents`, `total_draft_cents`, `total_sent_cents`, `total_accepted_cents`.

### 4.2 Create Estimate (Idempotent)

`POST /api/accounts/[accountId]/estimates`

**Headers**

| Header | Value |
|---|---|
| `Idempotency-Key` | UUID (recommended) |

**Body**

```json
{
  "title": "Q4 AI Implementation",
  "project_id": "optional-project-uuid",
  "currency": "USD",
  "valid_until": "2026-12-31",
  "tax_cents": 50000,
  "line_items": [
    {
      "description": "Senior AI Architect (40 hrs)",
      "quantity": 40,
      "unit_price_cents": 15000
    }
  ]
}
```

**Responses**

| Status | Meaning |
|---|---|
| `201 Created` | Estimate created, with computed `subtotal_cents`, `tax_cents`, `total_cents` |
| `201 Created` + `Idempotent-Replay: true` | Replay of a previously cached response |
| `409 Conflict` | Idempotency key reused with a different payload |

### 4.3 Get Estimate by ID

`GET /api/accounts/[accountId]/estimates/[id]`

Strictly verifies `estimate.account_id === accountId`. On mismatch, returns `404`.

### 4.4 Update Draft / Transition Lifecycle

`PATCH /api/accounts/[accountId]/estimates/[id]`

**Transition status**

```json
{
  "action": "transition",
  "targetStatus": "sent"
}
```

**Update content** (valid only in `draft` status)

```json
{
  "title": "Updated Scope Title",
  "line_items": []
}
```

### 4.5 Soft-Delete Estimate

`DELETE /api/accounts/[accountId]/estimates/[id]`

- Sets `deleted_at = NOW()`.
- Rejects deletion with `400 Bad Request` if status is `accepted`.

---

## 5. UI Components

All components live under `components/`.

### 5.1 [`account-estimates.tsx`](components/account-estimates.tsx)

- Integrated into the Account Overview page
- Financial KPIs: Total Pipeline, Sent, Won Revenue, Drafts
- Filter bar with search, status selector, and project picker
- Interactive table with quick view, edit, and status action buttons

### 5.2 [`estimate-dialog.tsx`](components/estimate-dialog.tsx)

- Modal for creating and editing drafts
- Dynamic line-item editor: add/remove rows, quantity, rate ($), real-time row totals
- Live subtotal, tax rate calculation, and grand total
- Auto-generates a client-side `Idempotency-Key`

### 5.3 [`estimate-preview-dialog.tsx`](components/estimate-preview-dialog.tsx)

- Professional invoice-style presentation
- Deliverables breakdown table
- Action triggers: **Send to Client**, **Accept Estimate**, **Mark Rejected**, **Delete Draft**

---

## 6. Running Tests

The suite uses [Vitest](https://vitest.dev/) and lives in [`__tests__/estimates.test.ts`](__tests__/estimates.test.ts).

```bash
# Run all unit and integration tests
npm test

# Watch mode
npx vitest

# Coverage report
npx vitest run --coverage
```

### Coverage Highlights

| Area | What is verified |
|---|---|
| **Money correctness** | Integer minor-unit arithmetic, decimal hour rates, rounding rules, negative price guards, IEEE-754 precision traps |
| **Lifecycle transitions** | All legal paths (`draft` → `sent` → `accepted`/`rejected`) and rejection of illegal paths |
| **Idempotency** | SHA-256 hash consistency, cache replay, payload mismatch conflict (`409`) |
| **Tenancy validation** | Blocking cross-tenant project association; blocking soft-deletion of accepted estimates |

---

## 7. Local Setup Guide

### Prerequisites

- Node.js **20.9+**
- A free [Supabase](https://supabase.com) project

### Installation

**1. Install dependencies**

```bash
npm install
```

**2. Configure environment**

```bash
cp .env.local.template .env.local
```

Fill in `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

**3. Apply SQL migrations** (in the Supabase SQL Editor, in this order)

| Order | File |
|---|---|
| 1 | `supabase/schema.sql` |
| 2 | `supabase/seed-roles.sql` |
| 3 | `supabase/estimates.sql` |

**4. Seed demo users**

```bash
npm run seed:users
```

**5. Start the dev server**

```bash
npm run dev
```

Visit <http://localhost:3000>.

---

## 8. What We Would Ship Next (Staff Roadmap)

To grow this revenue slice into a full enterprise billing engine:

### 8.1 Stripe Billing Integration
- Webhook worker listening to Stripe events
- Convert `accepted` estimates into Stripe Invoices and payment intents
- Store `stripe_invoice_id` and `stripe_payment_intent_id` on the estimate/billing record

### 8.2 Double-Entry General Ledger & Reconciliation
- Automated journal entries on acceptance (Debit: Accounts Receivable, Credit: Deferred Revenue)
- Real-time bank reconciliation of incoming Stripe/ACH deposits against open balances

### 8.3 Escrow Service Synchronization
- Hook into the existing Go `escrow-service` (`GO_ESCROW_SERVICE_URL`)
- Auto-provision an escrow contract when a client accepts a milestone-based estimate

### 8.4 Point-in-Time Exchange Rate Locking
- When sending an estimate in a non-base currency (e.g. EUR, GBP), snapshot the ECB spot rate into `exchange_rate_at_send`
- Prevents FX volatility from altering realized revenue at collection

### 8.5 PDF Generation & Digital Signature Portal
- Headless PDF rendering (`@react-pdf/renderer` or a Puppeteer worker) with company branding
- Client portal where external contacts can review and e-sign estimates
