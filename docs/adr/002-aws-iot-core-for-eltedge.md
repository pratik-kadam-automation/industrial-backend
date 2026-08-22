# ADR-002: AWS IoT Core as broker for eLT Edge

Status:   Accepted
Date:     2026-08-02
Deciders: P. Kadam

## Context
AWS is already standard at office with real client not POC. My time will he billable

## Options
A. AWS IoT Core
B. Self-hosted EMQX
C. HiveMQ Cloud

## Decision
AWS  won here as it has managed services, self hosting will consume my time as i hace to develop it one by one which aws already offering


## Consequences
+ Managed service; no broker uptime or upgrades to own
+ Rules engine, device shadow, fleet provisioning available immediately
- Per-message billing grows linearly with every machine added
- Vendor lock-in; migrating away later means rebuilding those features-

## Revisit when
Monthly AWS IoT Core spend exceeds 15% of platform revenue,
OR message volume passes 5 million per month.
