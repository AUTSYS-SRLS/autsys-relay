# AUTSYS PC BRIDGE V2 — Staging security gates

Branch: bridge-v2-staging-20261114. This branch is isolated from production branch pc-bridge-gateway. Do not enable automatic deploy for this branch.

## Fail-closed requirements before public deployment

1. Dedicated service, distinct credentials, least-privilege read-only command allowlist, explicit project-scoped authorization on ingress and worker.
2. Authenticated external enqueue endpoint with request signing, freshness and durable anti-replay; never expose local staging HTTP server directly.
3. Durable transactional server queue with safe restart/lease recovery and documented single-writer constraints or external shared storage; Render ephemeral filesystem is insufficient for durability.
4. Signed and nonce-protected request and ACK; stable worker identity, reconciliation for uncertain claims, no automatic duplicate execution.
5. TLS, request body and rate limits, safe error responses, audit logs without secrets, key rotation, health probes, rollback.
6. End-to-end test with real Render staging and Windows worker before promotion; do not modify V1.

Status 2026-11-14: local P36-P37 test suite passed 38/38; no remote V2 deployment. This file is a security checkpoint, not a deployable V2 application.
