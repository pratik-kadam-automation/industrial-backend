# ADR-001: OpenVPN for client gateway connectivity

Status:   Accepted
Date:     2026-08-01
Deciders: P. Kadam

## Context
Proof-of-concept stage. Small number of client sites.
Budget constrained. Team of one. Building internal
capability in networking is itself a goal.

## Options
A. OpenVPN self-hosted  - free, full control, we operate it
B. Tailscale            - easier, less to learn, per-device cost
C. Ewon / commercial box - vendor supported, high per-site cost

## Decision
A. Lowest cost at PoC scale, and the hands-on learning is
a deliberate benefit, not a side effect.

## Consequences
+ Zero licence cost; full control over routing and certs
+ Deep working knowledge of VPN internals
- We own all uptime and troubleshooting
- Manual CCD management does not scale past ~20 gateways

## Revisit when
Gateway count passes 20, OR gateway onboarding takes
more than 30 minutes of manual work.
