# ADR-010: Production runs in Docker, supervised by systemd

Status:   Accepted
Date:     2026-08-24
Deciders: P. Kadam

## Context
Manual node process on bare systemd worked but had no reproducible
build, no image versioning, and every deploy meant SCP plus manual
restart. WQ-07 built automated image builds; this closes the loop
by making production actually run the built image.

## Decision
systemd runs `docker run` in foreground (not detached), so it can
directly supervise the container process the same way it supervised
bare node. --network host avoids Docker bridge networking issues
reaching Postgres on localhost. Specific host paths (certs, OpenVPN
status logs, CCD dirs) are mounted individually rather than whole
directories, to avoid exposing private keys unnecessarily.

## Consequences
+ Auto-restart on crash proven via kill test
+ Every deploy is now a tagged, reproducible image
+ VPN fleet status visibility required explicit mounts -- initially
  missed, caused silent ENOENT errors, found and fixed same session
- systemd unit file is now a manually-maintained artifact; a bad
  edit (glued lines, wrong indentation) can silently break prod
- Full cutover (stop-and-swap) was tested and works, but has zero
  rollback automation -- WQ-08's original rollback design applies
  only to the pre-cutover verification step, not this final swap

## Revisit when
Rollback automation for the live cutover itself becomes worth
building, or a second engineer needs to safely edit this file.
