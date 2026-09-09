# pi-sandbox-dsh

A pi extension that confines the model's **write** actions with an OS boundary, modeled on a single reference source: [dsh](https://github.com/deepseek-ai/deepseek-harness).

## Model

**Continuous agent + global sandbox tier + progressive approval.** No plan/build dual mode, no command allowlist, no read hiding.

- Global sandbox tier (default `read-only`) is a persistent, session-wide write policy — not tied to a "planning phase".
- The tier ladder is strictly widening:

  ```
  read-only          — reads open, no writes
  workspace-write    — writes inside the workspace (+ temp)
  danger-full-access — no confinement
  ```

- When a write is denied, the model sees a `[sandbox: file access denied under <mode> mode]` marker and a hint that escalation is available. It retries with `sandbox_permissions` (the narrowest strictly-wider tier) + `justification`; a human approves; **only that call** runs under the wider tier.

## Design rules

1. The sandbox bounds **writes**, never **reads** — reading is unrestricted.
2. Tiers are global/continuous; there is **no `verify` sub-tier** and no plan/build switch.
3. Approval is **progressive escalation** (strictly wider ladder), not per-command popups or a command allowlist.
4. **Fail closed**: a confined tier with no usable backend refuses to run (`SANDBOX_UNAVAILABLE`), never silently runs unconfined.
5. Approval never enters the model context; escalation is per-call only.

## Backends

| Platform | Backend | Shell |
|---|---|---|
| Linux / WSL2 | bubblewrap | bash |
| Windows | restricted-token + NTFS ACE (winacl) | pwsh |

See [docs/architecture.md](docs/architecture.md) for the full design, and the local `AGENTS.md` (gitignored) for the design rationale.

## License

MIT
