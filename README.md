# industrial-backend

IIoT platform backend for eLT Edge — MQTT ingestion from AWS IoT Core, PostgreSQL storage, VPN fleet dashboard, and client-facing machine monitoring across Venus Wire, Gloster, Rubymill, Ashok Leyland, and Hlmando sites.

## Deployment

Deploys are automated via GitHub Actions. There is no manual deploy path — pushing a version tag is the only way to ship a release.

    git tag v0.x.x
    git push origin v0.x.x

This triggers three workflows: Verify (syntax and secrets check), Build and Push Image (Docker image to GHCR), and Deploy (pulls the fresh image on Oracle, verifies it against real dependencies in isolation, then tears it down). Production cutover is manual for now — see docs/adr/ for why.

## Local development

Requires Node 20, matching production. Copy .env.example to .env with real values. The app refuses to start if any required variable is missing.

    npm ci
    node server.js

Health check: GET /health — returns 200 only if the database and MQTT broker are genuinely reachable.

## Architecture decisions

Every non-trivial technical decision is recorded in docs/adr/.

## Production

Runs on Oracle Cloud, managed by systemd (industrial-backend.service).

    sudo systemctl status industrial-backend
    sudo journalctl -u industrial-backend -f
    sudo systemctl restart industrial-backend
