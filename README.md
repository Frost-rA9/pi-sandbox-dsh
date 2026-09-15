# pi-sandbox-dsh

A pi extension that confines the model's **write** actions with an OS boundary — the **enforcement axis** of the plan/enforcement split. Modeled on a single reference source: [dsh](https://github.com/deepseek-ai/deepseek-harness).

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

## Orthogonality

The plan/enforcement split mirrors dsh and is fully orthogonal:

| Axis | Extension | State | Role |
|---|---|---|---|
| Enforcement | `pi-sandbox-dsh` | `sandbox/mode` | write-boundary OS sandbox |
| Guidance | `pi-plan-dsh` | `plan/mode` | soft prompt guidance |

`sandbox` never reads or writes `plan` state (and vice-versa); the two are independent and configured separately. This mirrors dsh's own split: *"Plan mode is soft guidance. Sandbox mode and approval policy enforce restrictions independently; neither reads nor writes plan state."* Together this pair **replaces the deprecated `pi-plan-mode`**.

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

Windows prerequisites: a system `node` (the Bun host cannot run the Win32 runner subprocess — resolved from
`PI_SANDBOX_NODE`, then `PATH`, then the user/system registry `Path`) and the `koffi` optional dependency installed
by `npm install`. Under the restricted token PowerShell runs in `ConstrainedLanguage` mode (no .NET method calls) —
an inherent cost of the mechanism, see [docs/verify-windows.md](docs/verify-windows.md).

See [docs/architecture.md](docs/architecture.md) for the architecture and [DESIGN.md](DESIGN.md) for the design rationale and known trade-offs.

## License

MIT
