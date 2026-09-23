# pi-sandbox-dsh

A pi extension that confines the model's **write** actions — the **enforcement axis** of the plan/enforcement split.
Shell commands run under an **OS boundary** (bubblewrap on Linux/WSL2); the `write`/`edit` tools are held back by an
**in-process `tool_call` guardrail**, which is *not* a security boundary. Modeled on a single reference source:
[dsh](https://github.com/deepseek-ai/deepseek-harness).

> Contents: [Behavior model](#behavior-model) · [Install](#install) · [Usage](#usage) · [Platform support](#platform-support) · [Orthogonality](#orthogonality) · [Design rules](#design-rules) · [Commitment strength](#commitment-strength) · [Further reading](#further-reading)

## Behavior model

**Continuous agent + global sandbox tier + progressive approval.** No plan/build dual mode, no command allowlist, no read hiding.

- Global sandbox tier (default `read-only`) is a persistent, session-wide write policy — not tied to a "planning phase".
- The tier ladder is strictly widening:

  ```
  read-only          — reads open, no writes
  workspace-write    — writes inside the workspace (+ temp)
  danger-full-access — no confinement
  ```

- When a write is denied, the model sees a `[sandbox: file access denied under <mode> mode]` marker. File tools
  (`write`/`edit`) ask the user **in place** (allow once); a refusal or a missing interactive channel returns the denial
  reason plus a mode-switch hint (`/sandbox <wider tier>`) — pi's `write`/`edit` carry no per-call escalation parameter.
- Ladder rule (aligned with dsh `escalation.ts`, anchor `ddefc45fbc`): **repeating the call's effective tier needs no
  approval**; a wider tier requires approval and applies to that call only; a narrower or unsupported target fails before execution.

## Install

```bash
# from a local clone
pi install /absolute/path/to/pi-sandbox-dsh

# or directly from git
pi install git:github.com/Frost-rA9/pi-sandbox-dsh
```

Requirements:

- **Linux / WSL2** — [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`), e.g. `sudo apt install bubblewrap`.
  Without a working backend the confined shell **fails closed** (refuses to run rather than running unconfined).
- **Windows** — nothing to install; see [Platform support](#platform-support).

## Usage

- `/sandbox` — show the current tier, or switch it:
  `/sandbox <read-only|workspace-write|danger-full-access>` (Linux/WSL2 only). On Windows it only reports the fixed
  `danger-full-access` tier and refuses switching.
- Denied writes surface as `[sandbox: file access denied under <mode> mode]`; the `write`/`edit` tools then ask for
  "allow once" in place. Escalation is per-call and never enters the model context.

## Platform support

| Platform | Write sandbox | Shell | Tiers |
|---|---|---|---|
| Linux / WSL2 | bubblewrap (**real OS boundary**) | confined `bash` (always registered) | three-tier ladder, switchable |
| Windows | **none** (not claimed) | pi defaults (`bash` + `powershell`) | fixed `danger-full-access`, not switchable |

On Windows the extension confines nothing: it runs at a fixed `danger-full-access` tier, registers no shell override and
no write gate, and `/sandbox` only reports that fact. This is deliberate, not a gap to be patched later — the only
shipped Windows mechanism (a `WRITE_RESTRICTED` restricted token + NTFS ACE grants) is **fundamentally incompatible
with Schannel/SSPI**: every native-TLS HTTPS client (`curl`, `git https`, `Invoke-WebRequest`) fails before its
handshake, and no privilege or ACL tweak fixes it. Rather than ship a boundary that breaks native TLS, the Windows
backend was removed. The Linux/WSL2 rung is unchanged. Full evidence:
[docs/dsh-upstream-report.md](docs/dsh-upstream-report.md).

## Orthogonality

The plan/enforcement split mirrors dsh and is fully orthogonal:

| Axis | Extension | State | Role |
|---|---|---|---|
| Enforcement | `pi-sandbox-dsh` | `sandbox/mode` | write confinement: shell = OS boundary; write/edit = in-process guardrail |
| Guidance | `pi-plan-dsh` | `plan/mode` | soft prompt guidance |

`sandbox` never reads or writes `plan` state (and vice-versa); the two are independent and configured separately. This
mirrors dsh's own split: *"Plan mode is soft guidance. Sandbox mode and approval policy enforce restrictions
independently; neither reads nor writes plan state."* Together this pair **replaces the deprecated `pi-plan-mode`**.

## Design rules

1. The sandbox bounds **writes**, never **reads** — reading is unrestricted.
2. Tiers are global/continuous; there is **no `verify` sub-tier** and no plan/build switch.
3. Approval is **progressive escalation** (strictly wider ladder), not per-command popups or a command allowlist;
   repeating the effective tier is not an approval.
4. **Fail closed where a backend exists**: on Linux/WSL2 a confined tier with no usable backend refuses to run
   (`SANDBOX_UNAVAILABLE`), never silently runs unconfined. Windows has no backend at all → a fixed, visible
   `danger-full-access` (never a claimed-but-absent sandbox).
5. Approval never enters the model context; escalation is per-call only.

## Commitment strength

What is actually enforced:

- **Shell commands** (`bash`) run inside bubblewrap: writes outside the workspace are refused by the kernel. That is a
  **real OS boundary** for that tool.
- **`write` / `edit`** are confined by an in-process `tool_call` gate (path containment). It runs in the pi process with
  the user's own permissions, so it is a **guardrail, not a security boundary** — pi's own security doc warns that a
  partial in-process sandbox "would be easy to misunderstand as a security boundary". Do not rely on it against a
  determined bypass; for strong isolation run the whole `pi` process inside a container/VM (pi `docs/containerization.md`).
- Neither layer constrains `!` (your own commands) or RPC `bash`.

## Further reading

- [docs/architecture.md](docs/architecture.md) — mechanism mapping, invariants, known trade-offs, verification.
- [docs/dsh-upstream-report.md](docs/dsh-upstream-report.md) — evidence record behind the Windows decision.

## License

MIT
