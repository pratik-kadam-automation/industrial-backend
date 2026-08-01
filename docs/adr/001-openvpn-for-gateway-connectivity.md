# ADR-001: OpenVPN for client gateway connectivity

Status:   Accepted
Date:     2026-08-01
Deciders: P. Kadam

## Context
Proof-of-concept stage. Small number of client sites.
Budget constrained. Team of one. Oracle Cloud free tier
already provisioned as the hub. OpenVPN was chosen directly
without trialling alternatives; Tailscale and commercial
appliances were considered only in principle.

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
+ Onboarding automated — ~30 seconds marginal cost per gateway
- We own all uptime and troubleshooting
- No per-tunnel visibility; diagnosis is manual and does not scale

## Revisit when
VPN troubleshooting exceeds 4 hours in any month,
OR concurrent tunnels exceed the capacity of one VM,
OR a client contractually requires vendor-supported connectivity.
