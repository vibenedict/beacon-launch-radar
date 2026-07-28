# `datahub docker quickstart` fails opaquely on Python 3.9 (older CLI) against v1.5.x images — token signing key never generated

## Summary

On a machine whose default Python is **3.9**, `pip install acryl-datahub` resolves to **1.3.1.7** (the last release before `requires_python >=3.10`). Running `datahub docker quickstart` with that CLI pulls the **latest** quickstart images (currently `v1.5.0.6`), whose GMS now *requires* `DATAHUB_TOKEN_SERVICE_SIGNING_KEY` (made mandatory in #16385). But the 1.3.x CLI predates that same PR's `_resolve_token_service_secrets()` helper, so the key is never generated → `system-update` crashes → GMS/frontend never start.

Two problems compound:
1. **Version skew:** an older CLI happily launches newer images it can't satisfy.
2. **Opaque failure:** the CLI reports only `Unable to run quickstart - the following issues were detected: … system-update-quickstart exited with an error`. The actual cause is buried in the container logs and only shown if you rerun with the non-default `--dump-logs-on-failure`. (This is the same wall #18594 hit.)

## Environment

- Host: macOS (Apple Silicon), Docker 29.x
- Default Python: **3.9.6** (Xcode/system) → `pip install acryl-datahub` installs **acryl-datahub 1.3.1.7.post3**
- Quickstart images pulled: **v1.5.0.6**

## Repro

```bash
python3 --version            # 3.9.6
pip install acryl-datahub    # → 1.3.1.7.post3 (capped by requires_python >=3.10 on newer releases)
datahub docker quickstart
```

## Actual result

Infra comes up healthy, then:

```
✘ Container datahub-system-update-quickstart-1  Error service "system-update-quickstart" didn't complete successfully: exit 1
Unable to run quickstart - the following issues were detected:
- datahub-gms-quickstart is not running
- frontend-quickstart is not running
- system-update-quickstart exited with an error
```

The real cause is only visible via `docker logs datahub-system-update-quickstart-1`:

```
WARN  The "DATAHUB_TOKEN_SERVICE_SIGNING_KEY" variable is not set. Defaulting to a blank string.
ERROR [SpringApplication] Application run failed
Caused by: java.lang.IllegalArgumentException: authentication.tokenService.signingKey must be set and not be empty
    at com.linkedin.gms.factory.auth.DataHubTokenServiceFactory.validate(DataHubTokenServiceFactory.java:47)
```

## Root cause

- #16385 removed the hardcoded signing key (good) **and** added `_resolve_token_service_secrets()` to `docker_cli.py` to auto-generate/persist it.
- CLI 1.3.1.7 (the newest installable on Python 3.9) **does not contain** that helper — confirmed: `grep -r _resolve_token_service_secrets` in the installed 1.3.1.7 package returns nothing.
- So the mandatory validation added to the v1.5.x images can never be satisfied by that CLI.

## Workaround

```bash
export DATAHUB_TOKEN_SERVICE_SIGNING_KEY=$(openssl rand -hex 32)
export DATAHUB_TOKEN_SERVICE_SALT=$(openssl rand -hex 16)
datahub docker quickstart
```

…or use Python ≥3.10 so pip installs a CLI (≥1.4/1.5/1.6) that includes the auto-generation.

## Proposed fixes (any subset)

1. **Surface the real error on failure (highest value, smallest change).** When a quickstart container exits non-zero, print that container's last error lines by default — not only under `--dump-logs-on-failure`. This alone turns the opaque failure in #18594 into an actionable one. (PR drafted.)
2. **Version-skew guard.** Before launching, compare the CLI version to the resolved image/compose tag; if the CLI is materially older, warn (or hard-stop) with: *"Your acryl-datahub CLI (1.3.1.7) is older than the quickstart images (v1.5.0.6). Upgrade with `pip install -U acryl-datahub` (needs Python ≥3.10) or set DATAHUB_TOKEN_SERVICE_SIGNING_KEY/SALT."*
3. **Docs.** Note on the quickstart page that Python ≥3.10 is required to get a CLI new enough for current images.

## Related

- #16385 (merged) — introduced the mandatory key + the CLI auto-generation
- #18594 (open) — same symptom, no root cause identified; fix #1 above would have surfaced it
