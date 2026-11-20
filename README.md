# Kontrora — Staff Engineer Assignment (Revenue & Billing)

An enterprise-grade, multi-tenant Professional Services Automation (PSA) platform built with **Next.js (App Router)**, **TypeScript**, and **Supabase (PostgreSQL + RLS)**.

This repository implements the **Revenue & Billing: Estimates & Line Items** slice end-to-end with mathematical money-correctness, multi-tenant security boundaries, idempotent mutation APIs, strict lifecycle state machines, RBAC enforcement, and an interactive UI.

--- 

## Table of Contents
1. [Architecture Decisions](#architecture-decisions)
2. [Database Schema & Tenancy](#database-schema--tenancy)
3. [Lifecycle State Machine](#lifecycle-state-machine)
4. [Money Correctness & Arithmetic](#money-correctness--arithmetic)
5. [Idempotency Pattern](#idempotency-pattern)
6. [RBAC & Security Review](#rbac--security-review)
7. [API Specification](#api-specification)
8. [UI Components](#ui-components)
9. [Running Tests](#running-tests)
10. [Local Setup Guide](#local-setup-guide)
11. [What We Would Ship Next (Staff Roadmap)](#what-we-would-ship-next-staff-roadmap)

---

## 1. Architecture Decisions

### 1.1 Minor Units (Cents / BIGINT) for All Monetary Values
Floating-point arithmetic (IEEE-754) is notoriously susceptible to binary rounding drift (e.g. `0.1 + 0.2 === 0.30000000000000004`). In financial and billing software, storing or calculating floats leads to penny discrepancies, reconciliation failures, and auditing headaches.
- **Decision**: All monetary fields (`subtotal_cents`, `tax_cents`, `total_cents`, `unit_price_cents`, `amount_cents`) are strictly stored as `BIGINT` in the database and handled as integer minor units across backend services.
- **Client Presentation**: Currencies are formatted via `Intl.NumberFormat` on the presentation layer, but API submissions and DB calculations operate strictly on minor units.

### 1.2 Defense-in-Depth Multi-Tenancy
Multi-tenant isolation must never rely on a single defensive layer. We enforce tenancy at three independent boundaries:
1. **Database Triggers (`check_estimate_project_account`)**: Validates that any linked `project_id` actually belongs to the same `account_id`, making cross-tenant project spoofing impossible at the database level.
2. **Row Level Security (RLS)**: Enforces account-level read policies based on `auth.uid()`, checking account managers, account members, and client users.
3. **Application Server Guards (`requireAuthAndPermission`)**: Every API route validates account membership/management before performing any queries.

### 1.3 Idempotency via SHA-256 Request Fingerprinting
Network failures often cause clients to retry money-touching operations (`POST /api/accounts/[accountId]/estimates`). Without idempotency, retries risk duplicating estimates or billing records.
- We support the standard `Idempotency-Key` (or `X-Idempotency-Key`) header.
- Cached responses are stored in `idempotency_records` alongside a SHA-256 hash of the payload.
- If a client retries with the exact same key and payload, Kontrora replays the cached 201 response with header `Idempotent-Replay: true`.
- If a client reuses an idempotency key with a *different* payload, the server detects the conflict and rejects it with `409 Conflict`.

### 1.4 Finite State Machine & Immutability
Estimates follow a strict unidirectional state machine:
```
  [ draft ] ───────────► [ sent ] ───────────► [ accepted ] (terminal, immutable)
      │                     │
      ▼                     ▼
  [ rejected ]        [ rejected ] (terminal, immutable)
```
- Line items, quantities, and prices can **only** be modified in the `draft` state.
- Once `sent`, terms are locked.
- Once `accepted` or `rejected`, the estimate becomes permanently immutable.
- A database trigger (`check_estimate_immutability`) enforces this immutability even against direct SQL updates.

### 1.5 Soft Deletion (`deleted_at`)
Financial records must never be hard-deleted from production databases for regulatory and audit compliance.
- All estimates feature `deleted_at TIMESTAMPTZ DEFAULT NULL`.
- Queries filter `WHERE deleted_at IS NULL`.
- `DELETE` endpoints set `deleted_at = NOW()`.
- Estimates in `accepted` status **cannot** be deleted under any circumstances.

---

## 2. Database Schema & Tenancy

The migration file is located at [`supabase/estimates.sql`](file:///C:/Users/user/.gemini/antigravity/scratch/full-stack-assignment/supabase/estimates.sql).

### `estimates` Table
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | Primary Key, default `gen_random_uuid()` | Estimate identifier |
| `account_id` | `UUID` | NOT NULL, REFERENCES `accounts(id)` ON DELETE RESTRICT | Tenancy anchor |
| `project_id` | `UUID` | REFERENCES `projects(id)` ON DELETE SET NULL | Optional project linkage |
| `estimate_number` | `TEXT` | NOT NULL, Unique per account | Human-readable identifier (`EST-YYYY-XXXX`) |
| `title` | `TEXT` | NOT NULL | Proposal title |
| `description` | `TEXT` | NULLABLE | Scope summary |
| `status` | `TEXT` | NOT NULL, CHECK in (`draft`, `sent`, `accepted`, `rejected`) | Lifecycle stage |
| `currency` | `TEXT` | NOT NULL, DEFAULT `'USD'` | ISO 4217 3-letter code |
| `subtotal_cents` | `BIGINT` | NOT NULL, CHECK `>= 0` | Minor unit sum of line items |
| `tax_cents` | `BIGINT` | NOT NULL, CHECK `>= 0` | Minor unit tax |
| `total_cents` | `BIGINT` | NOT NULL, CHECK `>= 0` | Subtotal + tax |
| `idempotency_key`| `TEXT` | NULLABLE, Unique per account | Deduplication key |
| `valid_until` | `DATE` | NULLABLE | Expiration date |
| `notes` | `TEXT` | NULLABLE | Commercial terms |
| `created_by` | `UUID` | REFERENCES `user_profiles(id)` | Audit trail of author |
| `sent_at` | `TIMESTAMPTZ` | NULLABLE | Timestamp when sent to client |
| `accepted_at` | `TIMESTAMPTZ` | NULLABLE | Timestamp when approved by client |
| `rejected_at` | `TIMESTAMPTZ` | NULLABLE | Timestamp when declined |
| `deleted_at` | `TIMESTAMPTZ` | NULLABLE | Soft-deletion flag |
| `created_at` | `TIMESTAMPTZ` | DEFAULT `NOW()` | Audit creation timestamp |
| `updated_at` | `TIMESTAMPTZ` | DEFAULT `NOW()` | Auto-updated via trigger |

### `estimate_line_items` Table
| Column | Type | Constraints | Description |
|---|---|---|---|
| `id` | `UUID` | Primary Key | Item identifier |
| `estimate_id` | `UUID` | NOT NULL, REFERENCES `estimates(id)` ON DELETE CASCADE | Parent estimate |
| `description` | `TEXT` | NOT NULL | Deliverable description |
| `quantity` | `NUMERIC(10,2)`| NOT NULL, CHECK `> 0` | Hours or item count |
| `unit_price_cents`| `BIGINT` | NOT NULL, CHECK `>= 0` | Rate in minor units |
| `amount_cents` | `BIGINT` | NOT NULL, CHECK `>= 0` | `ROUND(quantity * unit_price_cents)` |
| `order_index` | `INTEGER` | NOT NULL, DEFAULT `0` | Display ordering |

### `idempotency_records` Table
Stores idempotency keys, SHA-256 payload hashes, status codes, and JSON response bodies with an automated 24-hour expiration window.

---

## 3. RBAC & Security Review

### Permission Additions
We extended the core permission system in [`lib/permissions.ts`](file:///C:/Users/user/.gemini/antigravity/scratch/full-stack-assignment/lib/permissions.ts):
- `Permission.VIEW_ESTIMATES = 'view_estimates'`: View proposals scoped to accounts the user has access to.
- `Permission.MANAGE_ESTIMATES = 'manage_estimates'`: Create drafts, update line items, and transition lifecycle states.
- `Permission.VIEW_ALL_ESTIMATES = 'view_all_estimates'`: Executive override to view estimates organization-wide.
- `Permission.MANAGE_ALL_ESTIMATES = 'manage_all_estimates'`: Executive override to manage estimates organization-wide.

### Role Mappings in [`supabase/seed-roles.sql`](file:///C:/Users/user/.gemini/antigravity/scratch/full-stack-assignment/supabase/seed-roles.sql):
- **Superadmin**: Full bypass across all routes.
- **Executive Director**: `view_all_estimates: true` (org-wide financial visibility).
- **Account Manager**: `view_estimates: true, manage_estimates: true` (scoped to their accounts).
- **Project Manager**: `view_estimates: true` (scoped to projects within their assigned accounts).
- **Client**: `view_estimates: true` (strictly scoped to their `client_account_id`).

### Route Guard Enforcement
Every route utilizes `requireAuthAndPermission`:
```typescript
await requireAuthAndPermission(Permission.VIEW_ESTIMATES, { accountId }, request);
```
If an attacker attempts to supply another account's UUID or an invalid ID, the request is stopped at the perimeter with a 403 Forbidden or 400 Bad Request.

---

## 4. API Specification

All routes are nested under `/api/accounts/[accountId]/estimates`:

### 4.1 List & Filter Estimates
`GET /api/accounts/[accountId]/estimates`
- **Query Parameters**:
  - `status`: Filter by `draft`, `sent`, `accepted`, `rejected`
  - `project_id`: Filter by associated project
  - `search`: Case-insensitive search on title and estimate number
  - `page`: Page number (default: 1)
  - `limit`: Page size (default: 20, max: 100)
- **Response**: Paginated estimates list + financial metrics (`total_value_cents`, `total_draft_cents`, `total_sent_cents`, `total_accepted_cents`).

### 4.2 Create Estimate (Idempotent)
`POST /api/accounts/[accountId]/estimates`
- **Headers**:
  - `Idempotency-Key`: UUID (recommended)
- **Body**:
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
- **Response (201 Created)**: Returns created estimate with computed `subtotal_cents`, `tax_cents`, and `total_cents`.
- **Replay**: Returns `201 Created` with header `Idempotent-Replay: true`.

### 4.3 Get Estimate by ID
`GET /api/accounts/[accountId]/estimates/[id]`
- Strictly checks that `estimate.account_id === accountId`. If mismatched, returns 404.

### 4.4 Update Draft / Transition Lifecycle
`PATCH /api/accounts/[accountId]/estimates/[id]`
- **Transition Status**:
```json
{
  "action": "transition",
  "targetStatus": "sent"
}
```
- **Update Content** (Only valid in `draft` status):
```json
{
  "title": "Updated Scope Title",
  "line_items": [...]
}
```

### 4.5 Soft-Delete Estimate
`DELETE /api/accounts/[accountId]/estimates/[id]`
- Sets `deleted_at = NOW()`.
- Rejects deletion if status is `accepted` (`400 Bad Request`).

---

## 5. UI Components

Located under account context in `components/`:
1. [`components/account-estimates.tsx`](file:///C:/Users/user/.gemini/antigravity/scratch/full-stack-assignment/components/account-estimates.tsx):
   - Integrated directly into the Account Overview page.
   - Financial KPIs (Total Pipeline, Sent, Won Revenue, Drafts).
   - Filter bar with search, status selector, and project picker.
   - Interactive table with quick view, edit, and status action buttons.
2. [`components/estimate-dialog.tsx`](file:///C:/Users/user/.gemini/antigravity/scratch/full-stack-assignment/components/estimate-dialog.tsx):
   - Modal for creating/editing drafts.
   - Dynamic Line-Item Editor: add/remove rows, quantity, rate ($), real-time row totals.
   - Live subtotal, tax rate calculation, and grand total.
   - Auto-generates client-side `Idempotency-Key`.
3. [`components/estimate-preview-dialog.tsx`](file:///C:/Users/user/.gemini/antigravity/scratch/full-stack-assignment/components/estimate-preview-dialog.tsx):
   - Professional invoice-style presentation.
   - Deliverables breakdown table.
   - Action triggers: "Send to Client", "Accept Estimate", "Mark Rejected", "Delete Draft".

---

## 6. Running Tests

The test suite is written with [Vitest](https://vitest.dev/) in [`__tests__/estimates.test.ts`](file:///C:/Users/user/.gemini/antigravity/scratch/full-stack-assignment/__tests__/estimates.test.ts).

```bash
# Run all unit and integration tests
npm test

# Run tests in watch mode
npx vitest

# Run tests with coverage report
npx vitest run --coverage
```

### Test Coverage Highlights:
- **Money correctness**: Integer minor unit arithmetic, decimal hour rates, rounding rules, negative price guards, and IEEE-754 precision trap verification.
- **Lifecycle state transitions**: Verification of all legal paths (`draft` → `sent` → `accepted`/`rejected`) and rejection of illegal paths.
- **Idempotency**: SHA-256 hash consistency, cache replay, and payload mismatch conflict detection (409).
- **Tenancy validation**: Blocking cross-tenant project association and blocking soft-deletion of accepted estimates.

---

## 7. Local Setup Guide

### Prerequisites
- Node.js **20.9+**
- Free [Supabase](https://supabase.com) project

### Installation
```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.local.template .env.local
# Fill in your NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY

# 3. Apply SQL migrations in Supabase SQL Editor
# First: supabase/schema.sql
# Second: supabase/seed-roles.sql
# Third: supabase/estimates.sql

# 4. Seed demo users
npm run seed:users

# 5. Start development server
npm run dev
# Visit http://localhost:3000
```

---

## 8. What We Would Ship Next (Staff Roadmap)

To expand this revenue slice into a full enterprise billing engine:

1. **Stripe Billing Integration**:
   - Webhook worker listening to Stripe events.
   - Converting `accepted` estimates into Stripe Invoices and payment intents.
   - Storing `stripe_invoice_id` and `stripe_payment_intent_id` on the estimate/billing record.
2. **Double-Entry General Ledger & Reconciliation**:
   - Automated journal entries upon estimate acceptance (Debit: Accounts Receivable, Credit: Deferred Revenue).
   - Real-time bank reconciliation reconciling incoming Stripe/ACH deposits against open balances.
3. **Escrow Service Synchronization**:
   - Hooking into the existing Go `escrow-service` (`GO_ESCROW_SERVICE_URL`).
   - Automatically provisioning an escrow contract when a client accepts a milestone-based estimate.
4. **Point-in-Time Exchange Rate Locking**:
   - When sending an estimate in non-base currencies (e.g. EUR, GBP), snapshot the European Central Bank (ECB) spot rate into `exchange_rate_at_send`.
   - Prevents FX volatility from altering realized revenue upon collection.
5. **PDF Generation & Digital Signature Portal**:
   - Headless PDF rendering (e.g. `@react-pdf/renderer` or Puppeteer worker) with company branding.
   - Client portal view allowing external client contacts to review and e-sign estimates directly.
#   f u l l - s t a c k - a s s i g n m e n t 
 
 
