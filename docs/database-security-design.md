# Database and security design (Phase 1)

This document records the planned design. The Supabase project has not been configured, and no SQL has been applied in this phase. Phase 2 will turn this plan into ordered, repeatable SQL migrations and test the policies against distinct Auth roles.

## Data model

All identifiers are UUIDs except the human-readable order number. Store timestamps as `timestamptz` in UTC; calculate business dates on the server using the configured `Africa/Algiers` zone and restaurant cutoff.

| Table | Purpose and key rules |
| --- | --- |
| `restaurant_settings` | One protected row: restaurant display name, time zone, business-day cutoff (default `04:00`), and settings version. Validate the zone and cutoff. |
| `staff_members` | Trusted authorization map from `auth.users.id` to active staff; records are inserted manually by an administrator using a trusted SQL session. Login alone never grants staff access. |
| `daily_order_counters` | One row per `business_date`; transactionally allocate numbers 1–999, unique by business date. If the daily limit is reached, fail clearly instead of reusing a number. |
| `orders` | UUID primary key, business date, short order number, status, notes, estimated preparation minutes, estimated ready time, timestamps, and a tracking-code version. Unique `(business_date, order_number)`. Status constrained to `received`, `preparing`, `ready`, `delivered`, `cancelled`. |
| `order_items` | UUID primary key, order FK with `ON DELETE CASCADE`, free-text item name, positive bounded quantity, and display position. No customer names or contact fields are needed for this workflow. |
| `order_verification_secrets` | One private row per order with random salt and HMAC digest of the six-digit code, plus pepper/version metadata. RLS enabled and no client policies. The pepper exists only in Edge Function secrets. |
| `tracking_grants` | Grant UUID, order FK, anonymous Auth user ID, token hash, code version, expiry and revocation timestamps. The raw 256-bit-or-stronger token is returned once and held in `sessionStorage`; never stored in URLs. No client table access. |
| `verification_attempts` | Server-written timestamps, order reference when known, result, and keyed hash of the source IP. Retention is short (initially 24 hours); no raw IP, code, or token. Used with atomic server-side limits. |
| `maintenance_runs` | Protected record of scheduled cleanup start/end, outcome and row counts; no order contents or credentials. Staff can see a summarized warning only through a protected operation. |

Indexes should cover `(business_date, order_number)`, active orders by `(status, created_at)`, order item position, grants by `(order_id, expires_at)`, and attempt lookups by keyed IP hash/time and order/time. Cascading order deletion removes items, code material, grants, and order-scoped attempts. IP-only attempt rows expire independently. Never cascade-delete staff identities from `auth.users` implicitly.

## Business date and order allocation

The database/server derives the business date from the current instant converted to the configured IANA zone. A local time before the configured cutoff belongs to the prior business date. The frontend clock is not authoritative. Allocate the next number and insert the order in one transaction while locking/upserting the counter row. The same short number can recur on a different business date, but never twice on one business date.

At cutoff, older unfinished orders remain visible to authorized staff but become ineligible for customer verification and grants. Existing grants must also fail server revalidation after cutoff; a previously opened page must not be treated as permanently authorized.

## Authentication, authorization, and RLS

- Disable public staff sign-up. Create staff Auth accounts manually and separately insert their IDs into `staff_members` from a trusted administrator session.
- Enable RLS on every exposed table, including tables in any schema reachable through the Data API. Revoke unnecessary table privileges as well as writing restrictive policies.
- Customers may use Supabase anonymous Auth, but receive no direct `SELECT`, `INSERT`, `UPDATE`, or `DELETE` rights on orders, items, verification secrets, grants, attempts, maintenance logs, or staff records.
- A narrowly scoped `is_staff()` helper may be `SECURITY DEFINER`; pin its `search_path`, schema-qualify referenced objects, revoke public execution, and base its answer only on the protected `staff_members` table. Test for recursion and privilege escalation.
- Staff reads use a staff-checking RLS policy. All writes go through narrowly scoped Edge Functions/RPCs which recheck staff authorization and enforce status transitions. Do not expose a service-role key in browser code.
- The only customer data path is an Edge Function that verifies order number/code and issues a grant, followed by an Edge Function that validates the grant and returns that one order. No public order lookup or broad anonymous policy.
- Keep private tables out of the exposed API schema where practical. RLS remains required even when tables are private.

## Verification and grant flow

The customer page first signs in anonymously, then POSTs order number and code to a verification Edge Function over TLS. The function returns the same generic failure for unknown order, wrong code, expired order, and locked order. It applies an atomic maximum of 10 failures per order and about 8 attempts per keyed IP hash per 15 minutes. Avoid timing differences and logs that reveal existence. A shared database-backed rate-limit operation is required; in-memory function state is insufficient.

Generate a per-order random salt and compute a keyed HMAC-SHA-256 digest using a pepper in Supabase Function secrets; compare digests in constant time. On success create a random tracking token with at least 256 bits of entropy, store only its hash, and bind the grant to `auth.uid()`. The grant expiry is the earliest of four hours, order creation plus 30 days, or (for Delivered/Cancelled) status-change plus 15 minutes. A code reset increments the order's code version and revokes prior grants. Revalidate grant, user binding, code version, business date, and order access window on each state fetch and realtime authorization.

Store the raw tracking token in `sessionStorage`, scoped to the tab and cleared on logout/expiry. This reduces persistence on shared restaurant devices compared with `localStorage`, but both are readable by same-origin JavaScript: XSS can steal either value. Use textContent for untrusted item names/notes, avoid unsafe HTML, deploy a restrictive Content Security Policy, keep dependencies small, and never put codes/tokens into URLs, analytics, or error reports. Logout clears the token and may sign out the anonymous Supabase session; server-side revocation remains authoritative.

## Realtime design

Use private Broadcast topics scoped to a random grant identifier, not an order number. Authorization policy on `realtime.messages` must prove the current Auth UID owns the active grant and that its order/version/window remain valid. Publish only a minimal event (order ID/status/version/timestamp) after a successful staff status change. The client then fetches the authorized order through the grant-checking function. On reconnect, visibility return, or network restoration, re-fetch the complete authorized state.

Test revocation while subscribed. Authorization checks control future delivery/subscription actions; bytes already delivered to a client cannot be recalled, so the UI should clear order data after a failed revalidation and the security model must not promise retroactive erasure.

## Retention and maintenance

Use a Supabase-supported `pg_cron` job to invoke a database cleanup routine daily. It deletes orders with `created_at < now() - interval '30 days'`; foreign keys cascade related order data. Clean expired IP-only attempt data. Record run outcome and counts in `maintenance_runs`, and expose a staff-only overdue/failure warning. Check both the job configuration and its execution history: a scheduled job definition alone does not prove that a cleanup ran successfully. Validate the scheduler extension and project plan in Phase 2 before relying on it.

## Decisions deferred to Phase 2

- Exact Supabase Auth anonymous-sign-in and redirect configuration.
- SQL migration implementation, helper grants, policies, and role-based policy tests.
- Whether Turnstile can be added without blocking legitimate customers; rate limiting is required either way.
- Realtime authorization policies and end-to-end revocation test in the target Supabase project.
- Supported cron extension/scheduling path in the selected project.
