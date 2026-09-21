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

- When a write is denied, the model sees a `[sandbox: file access denied under <mode> mode]` marker. File tools (write/edit) ask the user **in place** (allow once); a refusal or a missing interactive channel returns the denial reason plus a mode-switch hint (`/sandbox <wider tier>`) — pi's write/edit carry no per-call escalation parameter.
- Ladder rule (aligned with dsh `escalation.ts`, anchor `ddefc45fbc`): **repeating the call's effective tier needs no approval**; a wider tier requires approval and applies to that call only; a narrower or unsupported target fails before execution.

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
3. Approval is **progressive escalation** (strictly wider ladder), not per-command popups or a command allowlist; repeating the effective tier is not an approval.
4. **Fail closed where a backend exists**: on Linux/WSL2 a confined tier with no usable backend refuses to run (`SANDBOX_UNAVAILABLE`), never silently runs unconfined. Windows has no backend at all → a fixed, visible `danger-full-access` (never a claimed-but-absent sandbox).
5. Approval never enters the model context; escalation is per-call only.

## Backends

| Platform | Backend | Shell |
|---|---|---|
| Linux / WSL2 | bubblewrap | bash |
| Windows | **none** — fixed `danger-full-access` | pi defaults (`bash` + `powershell`) |

### Windows has no OS write sandbox

On Windows this extension does **not** confine anything: it runs at a fixed `danger-full-access` tier, and `/sandbox`
only reports that fact (switching is refused). This is deliberate, not a gap to be patched later:

- The only shipped Windows mechanism — a `WRITE_RESTRICTED` restricted token with NTFS ACE write grants — is
  **fundamentally incompatible with Schannel/SSPI**: every HTTPS client on the Windows TLS stack (`curl`,
  `git https`, `Invoke-WebRequest`) fails before its handshake with
  `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030E)`. Dropping `DISABLE_MAX_PRIVILEGE` or
  adding SIDs to the restricting list does not help, so **no privilege or ACL tweak fixes it** (measured; the evidence
  is archived in [docs/dsh-upstream-report.md](docs/dsh-upstream-report.md)). Python tooling built on `tempfile`
  (`pip`, `pytest`) was a second, separate gap with no workaround.
- The candidate replacement (Low Integrity + mandatory labels) is **unverified**, has **no counterpart in the single
  reference source (dsh)**, and adopting it would cost the reference anchor — a poor trade for a write-only boundary.
- Rather than keep a mechanism that appears to confine writes while breaking native TLS, the extension **removed the
  Windows backend** and states the boundary honestly: no OS sandbox, no tier switching.

Because there is no confinement on Windows, no shell override and no write gate are registered: the model gets pi's
normal shell tools, and your own `!` commands behave as usual. Linux/WSL2 is unchanged (bubblewrap + fail-closed).

See [docs/architecture.md](docs/architecture.md) for the architecture, design invariants, and known trade-offs.

## License

MIT
