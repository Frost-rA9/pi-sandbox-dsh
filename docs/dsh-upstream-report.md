# Upstream report: win32 rung boundary claims vs. measurements

**Target**: dsh `packages/sandbox/sandbox-windows-acl` (anchor `ddefc45fbc`; local clone verified at `0d1f50007`, 2026-09-15).
**Measured on**: Windows 11 build 26200, 2026-09-20, Node 24, the shipped koffi binding path.
**Status**: self-archived reference — **not** filed upstream, and not planned to be. The upstream repo
`deepseek-ai/deepseek-harness` has Issues disabled and its `CONTRIBUTING.md` states that external pull requests are not
accepted; the sanctioned channel is GitHub Discussions. This file therefore serves as (a) the port's own evidence record
for future sessions and (b) a ready-to-reuse write-up if a Discussion post is ever wanted. The port (`pi-sandbox-dsh`)
pins these findings in `npm run probe` (the 「HTTPS」 section), so nothing here needs re-deriving.

## 1. `WRITE_RESTRICTED` breaks Schannel credential acquisition (mechanism level)

Claimed in `packages/sandbox/sandbox-windows-acl/README.md` → "Verified boundaries":

> **Writes are restricted; reads, network, and process visibility are not** — `WRITE_RESTRICTED` intersects write
> accesses only, so a confined child can read any caller-readable file **and open sockets**

and in `docs/subsystems/sandbox.md`: "Network and process visibility are outside this vocabulary."

Measured: sockets do open, but **no Schannel-based client can complete TLS** inside a confined child.

| client (confined, `workspace-write`) | result |
|---|---|
| `curl.exe -sS https://api.github.com/` | `(35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030E)` |
| `git ls-remote https://github.com/wez/wezterm` | same signature (libcurl + Schannel) |
| `Invoke-WebRequest https://…` | fails (same stack) |
| `node -e "require('node:https')…"` (OpenSSL) | ✓ works |
| `python -c "urllib…"` (OpenSSL) | ✓ works |

Bisection of the `CreateRestrictedToken` inputs — one flag/SID changed at a time, child = `curl` against a local
listener so the TCP connect always succeeds (see the harness note at the end):

| flags | restricting SIDs | Schannel credential |
|---|---|---|
| `0` (plain token copy) | — | ✓ |
| `DISABLE_MAX_PRIVILEGE \| LUA_TOKEN` (0x5) | — | ✓ |
| `WRITE_RESTRICTED` alone (0x8) | — | child dies at DLL init (`0xC0000142`) |
| `0x5 \| 0x8` | `[logon, Everyone]` | ✗ `SEC_E_NO_CREDENTIALS` |
| `0x5 \| 0x8` | `[logon, Everyone, <caller's own user SID>]` | ✗ **same failure** |

The last row is decisive: putting the caller's **own** SID into the restricting list (pass-2 then succeeds wherever the
caller's ambient ACEs do) does not help → this is not a missing ACE, and **no per-path grant can fix it**. Corroborating
negative result: a per-session create-only ACE on the CNG key-container directory
(`%APPDATA%\Microsoft\Crypto\Keys`, where Schannel persists its session key containers) left the failure unchanged.

Practical consequence: a confined Windows child cannot run `curl`, `git https`, or .NET HTTPS clients at all. A git-only
workaround exists: `git -c http.sslBackend=openssl …` works in **both** confined modes (Git for Windows ships both
backends; only the config takes effect — the `GIT_SSL_BACKEND` environment variable does not).

## 2. Component-created DACLs exclude the capability SIDs

Separate failure class, same root: an object a component creates with **its own** security descriptor does not inherit
the capability ACEs, so the restricted child cannot write inside it.

| probe (confined, `workspace-write`, inside the granted private temp dir) | result |
|---|---|
| `python -c "tempfile.mkdtemp() then write"` | ✗ `PermissionError` |
| `python -c "os.makedirs() then write"` (no chmod) | ✓ |
| `node -e "fs.mkdtempSync() then write"` | ✓ |

CPython chmods the directory it created for `mode=0o700`, replacing the inherited ACE with an owner-only DACL. Every
Python tool built on `tempfile` (pip, pytest, …) therefore cannot run in a confined mode, and relocating the temp root
does not help — the DACL itself is what changed.

## 3. Test coverage

The 13 spec files under `packages/sandbox/sandbox-windows-acl/tests/` contain no `https`/`fetch`/socket assertion, so
both findings above are invisible to the suite. The suite already pins comparable gaps (e.g. the "partial boundary"
Everyone-Modify case), so a pin case for TLS credential acquisition would fit the existing style.

## Suggested changes

1. Correct the boundary wording in `packages/sandbox/sandbox-windows-acl/README.md` and `docs/subsystems/sandbox.md`
   ("network is not restricted" → "sockets are not restricted; Schannel-based TLS currently fails under
   `WRITE_RESTRICTED`, while OpenSSL/Go/rustls/OpenSSH clients are unaffected").
2. Pin the credential-acquisition signature in a test (and flip it to an end-to-end HTTPS assertion if the mechanism
   ever makes Schannel work).
3. Document the git exit (`http.sslBackend=openssl`) as the supported https path inside confined modes.
4. Document the component-DACL class (section 2) as a property of the rung.

## Repro harness (as run)

```sh
node --experimental-strip-types packages/sandbox/sandbox-windows-acl/src/runner.ts \
  --workspace <existing-dir> --temp <existing-dir> --mode workspace-write -- \
  curl -sS -o NUL -w 'code=%{http_code}' https://api.github.com/
```

Notes for anyone reproducing this: the failure happens during TLS **initialization**, after a successful TCP connect —
against a closed local port `curl` exits `7` before it ever attempts TLS, so the observation needs a peer that accepts
the connection (a local listener, or a proxy whose `CONNECT` succeeds).
