# Disaster Recovery Runbook

Last written: 2026-08-29, after WQ-09b's backup/restore was proven live.
Every command in this document has actually been run and confirmed working — not generic advice.

## What this system depends on

- **Server:** Oracle Cloud VM `iiot-vpn-prod`, IP `140.245.192.214`, Ubuntu 22.04, 1GB Always-Free tier, SSH as `ubuntu`
- **Runtime:** Node 20 (matches `node:20-alpine` in the Dockerfile)
- **Database:** PostgreSQL 14.24, database `factory_data`, app connects as user `pratik`
- **MQTT:** AWS IoT Core (`a3ayofuofs0ggs-ats.iot.ap-south-1.amazonaws.com`), client ID `elt-backend-prod`
- **Notifications:** public `ntfy.sh`, topic `pratik-gateway-alerts`
- **Repo:** `github.com/pratik-kadam-automation/industrial-backend`
- **Deploy target:** `backend-live` Docker container, supervised by the `industrial-backend.service` systemd unit
- **GitHub Secrets required for CI:** `ORACLE_HOST`, `ORACLE_USER`, `ORACLE_SSH_KEY` — used by `deploy.yml` and `db-backup.yml`

---

## Scenario 1: Total loss of the Oracle VM

If the instance itself is gone — terminated, corrupted, unrecoverable — here's the real path back, in order.

1. **Provision a new Ubuntu 22.04 VM** on Oracle Cloud (or equivalent), matching the current spec.
2. **Install prerequisites:** Docker, PostgreSQL 14, Node 20, `ntfy` CLI.
3. **Restore the database** — see Scenario 2 below, using the most recent nightly backup artifact from GitHub Actions.
4. **Restore secrets and certs** — `.env` (DB credentials, MQTT client cert paths), `/home/ubuntu/certs/` (VPN and MQTT certificates), OpenVPN config under `/etc/openvpn/server/`. **None of these are in the git repo or the backup artifact by design** — they must be restored from wherever they're separately kept (password manager, secure notes, or regenerated from AWS IoT Core / your CA if lost entirely).
5. **Point GitHub Secrets at the new host** — update `ORACLE_HOST` in the repo's Actions secrets to the new IP.
6. **Deploy** — push any tag (e.g. re-push the current version) to trigger `deploy.yml`, which will pull the image, verify, and cut over automatically.
7. **Verify:** `curl http://localhost:3000/health` should show `database: true, mqtt: true`.

## Scenario 2: Database restore (server intact, data lost or corrupted)

Proven live, 2026-08-29 — this exact sequence restored real data into a scratch database with zero data-loss errors.

```bash
# Download the latest backup artifact from the "Database Backup" workflow's
# most recent successful run (Actions tab → Database Backup → latest run → Artifacts)

# Restore into the real database (only do this if factory_data is actually gone/corrupted —
# this will not merge, it restores into whatever target you point it at):
PGPASSWORD=<db_password> pg_restore -h localhost -U pratik -d factory_data --no-owner /path/to/db-backup.dump
```

**To verify a restore worked**, check real row counts against what you expect:
```bash
psql -h localhost -U pratik -d factory_data -c "SELECT COUNT(*) FROM audit_logs;"
psql -h localhost -U pratik -d factory_data -c "SELECT COUNT(*) FROM users;"
```

## Scenario 3: Bad deploy that automatic rollback somehow doesn't catch

WQ-08b's automatic revert has been proven live against a deliberate failure — but if it's ever unavailable or doesn't trigger, here's the manual fallback, the same commands used before that automation existed:
```bash
# Find the last-known-good image SHA (recorded before every deploy):
cat ~/industrial-backend/.last-good-image

# Retag it as :latest and restart:
docker tag <that-sha> ghcr.io/pratik-kadam-automation/industrial-backend:latest
sudo systemctl restart industrial-backend

# Confirm:
curl http://localhost:3000/health
```

## Backup schedule and retention

Nightly, 2 AM UTC, via `.github/workflows/db-backup.yml`. Also runs immediately if manually triggered from the Actions tab. Stored as a GitHub Actions artifact, 14-day retention — if more than 14 days pass without checking, older backups will have expired. Success and failure both notify via ntfy; a failure notification is urgent-priority and means this protection has a real gap until fixed.

## What this runbook does NOT cover yet

- Automated tests (WQ-09c) — not built, so a restored/rebuilt system currently has no automated way to verify correctness beyond manual health checks
- A fully automated rebuild script — this document is a manual runbook, not a one-command recovery
