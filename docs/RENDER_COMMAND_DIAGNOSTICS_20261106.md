# AUTSYS Render command diagnostics — implementation contract (2026-11-06)

## Verified baseline
- Gateway: server.js, branch pc-bridge-gateway.
- In-memory maps: bridges, pending, bridgeQueues, uncertainBridges, readCooldowns.
- Existing protected GET /api/status exposes bridge connections, pendingRequests, uncertainBridges, readCooldowns and pendingDetails.
- Pending requests are removed on timeout, so the existing endpoint cannot reconstruct completed, timed-out, queued, or late-acknowledged commands after the fact.
- State in maps disappears on a gateway redeploy/restart.

## Required additions
1. Append-only persistent command event ledger outside Render instance RAM, keyed by requestId and bridgeId. Never log arguments, tokens, credentials or full responses.
2. Lifecycle: RECEIVED, QUEUED, DISPATCHED, ACKNOWLEDGED, SUCCEEDED, FAILED, TIMED_OUT, OUTCOME_UNCERTAIN, RECONCILED. Include UTC timestamps, operation name, duration, and sanitized error code.
3. Record QUEUED before serializeBridge; record DISPATCHED immediately before WebSocket send; store all transitions and terminal outcome.
4. Add authenticated read-only diagnostic endpoints for aggregate counts, queue order and per-request history. Avoid exposing the control token or private request bodies.
5. Persist outstanding command IDs and uncertain mutations across redeploys. On restart, mark unacknowledged mutations OUTCOME_UNCERTAIN, never automatically replay them.
6. Late replies must reconcile by requestId; distinguish a read timeout from a mutation whose outcome is unknown.
7. Explicitly show Bridge connectivity and command queue independently; health=OK does not mean queue empty.
8. Preserve per-bridge serialization, read-only diagnostic access during uncertainty, and non-replay of uncertain mutations.

## Rollout
- Stage changes on this branch; test lifecycle transitions, timeout/reconnect, duplicate request IDs and restart recovery.
- Select and provision a durable datastore before enabling persistence.
- Deploy only after verifying no effect on active command execution, and verify Render logs/metrics plus status endpoint after deployment.
