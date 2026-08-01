# ADR-003: Self-hosted EMQX for sLogic, migrate to AWS on first revenue

Status:   Accepted
Date:     2026-08-02
Deciders: P. Kadam

## Context
sLogic is pre-revenue. No paying customers yet. Cost must
stay near zero. Broker operations knowledge is a capability
gap worth closing while the stakes are low.

## Options
A. AWS IoT Core        - managed, feature-rich, per-message cost
B. Self-hosted EMQX    - flat VM cost, we operate it, we learn it
C. HiveMQ Cloud        - managed, higher price floor

## Decision
B. At zero revenue, cash cost matters more than operational
convenience. Running the broker ourselves also closes a
capability gap that AWS would otherwise hide.

## Consequences
+ Near-zero marginal cost while pre-revenue
+ Direct operational knowledge of broker internals
- We own uptime, upgrades and troubleshooting
- Features AWS provides free (rules engine, device shadow,
  fleet provisioning) must be built or done without

## Revisit when
sLogic has its first paying customer. At that point
operational burden becomes a real cost against real
revenue, and migration
