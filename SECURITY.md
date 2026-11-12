# Security

`lean-context` is an archived prototype, not a maintained production plugin.

## Deployment assumption

Use it in a **single-user / owner-controlled** OpenClaw deployment. Commands are restricted to
`ctx.isAuthorizedSender`, but the plugin still reads a ledger that may contain conversation data.

## Fixed in the 2026.11.3 port

1. **Cross-session command reads**
   Commands now default to the caller's own session (`ctx.sessionId` / `ctx.sessionKey`).
   Explicit `<sessionId>` / `<sessionKey>` arguments are rejected unless
   `allowCrossSessionCommands: true` is set by the operator.

2. **File permissions**
   Session state, ledgers, archives, and pending queues are written with `mode: 0o600` and their
   directories are created with `mode: 0o700`. A best-effort `chmod` is applied after writes.
   On Windows these POSIX modes are a no-op; the hardening is effective on Linux/WSL/macOS.

## Residual risk

- OpenClaw 2026.11.x exposes session identity to commands, so the plugin can bind to the caller's
  conversation. However, if a host invokes the command without session identity, `latest` and
  `board` fall back to the global turn ledger. Do not enable this plugin on a shared channel where
  multiple untrusted users share one authorized identity.
- Transcript and savings data are stored under the OpenClaw state directory. Protect that directory
  at the host level as well; file modes only cover the files this plugin creates.
- Host memory search recall is disabled in this port because OpenClaw 2026.11.x no longer exposes
  `getMemorySearchManager` through the public plugin SDK. Only archive recall and session memory
  remain.

## Reporting

This project is archived and unmaintained. If you find a problem, open a GitHub issue for the
record; there is no response-time commitment.
