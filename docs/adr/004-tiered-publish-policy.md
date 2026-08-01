# ADR-004: Tiered publish policy at the edge

Status:   Accepted
Date:     2026-08-02
Deciders: P. Kadam

## Context
<Why does publish frequency matter at all? Think: message
volume, broker cost, network on client sites.>

## Options
A. Everything on a fixed 30s timer
B. Everything on change
C. Tiered — critical discrete values on change, continuous
   values on interval

## Decision
C. <Why? Two sentences. One on why counts must publish on
change, one on why energy values should not.>

## Consequences
+ 
+ 
- 

## Revisit when
<What would make you change this? Hint: what if message
volume becomes the dominant cost?>
