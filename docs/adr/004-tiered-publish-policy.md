cat > docs/adr/004-tiered-publish-policy.md << 'EOF'
# ADR-004: Tiered publish policy at the edge

Status:   Accepted
Date:     2026-08-02
Deciders: P. Kadam

## Context
Gateways publish over client networks to a broker billed
per message. Publish frequency drives broker cost, bandwidth
on constrained site links, and historian storage volume.

## Options
A. Everything on a fixed 30s timer
B. Everything on change
C. Tiered - critical discrete values on change, continuous
   values on interval

## Decision
C. Discrete production values (product count, size, length,
type change) publish on change, because a value that changes
twice within one interval would be lost entirely under a timer.
Continuous values (energy, running parameters) publish every
30 seconds, because analogue signals change constantly and
publishing on every change would flood the broker with
messages carrying no useful information.

## Consequences
+ Production counts are never lost between intervals
+ Message volume stays far below publish-on-change everywhere
+ Node-RED flow.set / flow.get caching keeps this logic at
  the edge, so the network never sees the noise
- Two publish patterns to maintain and document per tag
- Continuous values still publish when nothing has changed;
  a deadband is not yet applied

## Revisit when
Message volume becomes a dominant cost line, OR migration
to AWS IoT Core makes per-message billing material. At that
point apply a percentage deadband plus a slow heartbeat to
the continuous tier.
EOF
