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
4. **Fail closed**: a confined tier with no usable backend refuses to run (`SANDBOX_UNAVAILABLE`), never silently runs unconfined.
5. Approval never enters the model context; escalation is per-call only.

## Backends

| Platform | Backend | Shell |
|---|---|---|
| Linux / WSL2 | bubblewrap | bash |
| Windows | restricted-token + NTFS ACE (winacl) | pwsh |

On Windows the model's shell is **`pwsh` in every mode** — the confined `pwsh` under the restricted token, and the
local `pwsh` under `danger-full-access`. The default `bash` tool (git-bash) is not confinement-capable: the restricted
token cannot start MSYS2 at all (its runtime dies at DLL init with `couldn't create signal pipe, Win32 error 5`;
measured in both confined modes, while native `git.exe`/`node`/`cmd` run fine), so it is **removed from the model's
tool list** on Windows — dsh's "one shell stack per host" — with the `tool_call` gate kept as a backstop.
`danger-full-access` does **not** bring `bash` back: it removes confinement, it does not add a shell. Your own `!`
commands still use git-bash. On Linux the confined shell *is* `bash`, so the same-name override is complete.

Setting `defaultTools: ["read", "powershell", "edit", "write"]` (pi's Windows recipe) is **not needed**: the extension
removes `bash` itself at `session_start`, which runs before the first model request. Set it only if you also want the
built-in `bash` gone in sessions where this extension is not mounted.

Windows prerequisites: a system `node` (the Bun host cannot run the Win32 runner subprocess — resolved from
`PI_SANDBOX_NODE`, then `PATH`, then the user/system registry `Path`) and the `koffi` optional dependency installed
by `npm install`. Under `read-only`, PowerShell runs in `ConstrainedLanguage` mode (no .NET method calls — its startup
AppLocker probe cannot write its temp files); `workspace-write` has a private temp directory, so the probe completes
and the mode stays `FullLanguage` (measured).

See [docs/architecture.md](docs/architecture.md) for the architecture, design invariants, and known trade-offs.

## License

MIT
