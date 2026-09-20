# ADR-004 — Billing idempotency: insert-before-process ledger + API refetch

- **Status:** Accepted
- **Date:** 2026-08
- **Requirements:** R9, R10

## Context

Stripe delivers webhooks at-least-once and out-of-order. Naively applying each event's payload
risks double-processing on redelivery and regressing state when an older event arrives after a
newer one.

## Decision

1. **Verify** the `Stripe-Signature` with `constructEvent` (raw body) before any processing;
   reject unsigned/forged with `400` and no mutation.
2. **Insert the Stripe `event.id`** into a UNIQUE `processed_webhooks` ledger **before** business
   logic. A duplicate-key error is the dedup signal → return `200` no-op (safe under redelivery).
3. **Refetch** the current subscription object from the Stripe API rather than trusting the event
   payload — tolerates out-of-order delivery.
4. Sync `subscriptions.status` + `organizations.plan`; `invoice.payment_failed` → `past_due`;
   `canceled` → downgrade to `free` entitlements.
5. Acknowledge within Stripe's timeout (5s budget), enqueue slow work if needed.

## Consequences

- A small ledger table and one extra Stripe API read per new event — correctness over
  micro-latency on the webhook path.
- Verified: a redelivered event id is a no-op; `invoice.payment_failed` drives `past_due`; forged
  signature → `400`.
