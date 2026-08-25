# ADR-011: is_admin remains authoritative; role is not yet enforced

Status:   Accepted
Date:     2026-08-24
Deciders: P. Kadam

## Context
WQ-10 added a `role` column (viewer/operator/engineer/admin) alongside
the existing `is_admin` boolean. `requireAdmin` in auth.js already
re-checks `is_admin` live against the database on every request
(deliberately, so a revoked admin can't keep using a stale token).
`role` is not yet read by any enforcement code.

## Decision
`is_admin` stays the single source of truth for privilege checks
until WQ-12 builds real role-based middleware. `role` exists now
only as data, not as enforcement -- prevents two competing checks
disagreeing with each other in the gap between WQ-10 and WQ-12.

## Consequences
+ No risk of is_admin and role disagreeing during the transition
+ requireAuth's DB re-check pattern (used only by requireAdmin
  today) is documented here as the model WQ-12 should copy for
  role-based routes
- requireAuth itself does NOT re-check is_active against the DB --
  a deactivated user's token stays valid until it expires. Real gap,
  not yet fixed.

## Revisit when
WQ-12 begins -- role-based middleware should replace is_admin
checks entirely, not run alongside them.
