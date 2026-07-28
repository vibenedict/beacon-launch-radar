# PR draft: surface the failing container's error when `datahub docker quickstart` fails

**Title:** `fix(cli): show the failing container's logs when quickstart fails (not just "issues were detected")`

**Fixes:** #18594 · **Related:** #16385

## Problem

When `datahub docker quickstart` times out waiting for health, it writes all compose logs to a temp file but only prints them if the user passed `--dump-logs-on-failure` (default `False`). So the default experience is:

```
Unable to run quickstart - the following issues were detected:
- datahub-gms-quickstart is not running
- system-update-quickstart exited with an error
```

…with no indication of *why*. The real cause (e.g. `authentication.tokenService.signingKey must be set and not be empty`) is hidden. Users are left to discover `docker logs <container>` themselves. This is exactly the frustration in #18594.

## Change

In the failure branch of `_run_quickstart` in
`metadata-ingestion/src/datahub/cli/docker_cli.py` (the `else` of the health-poll
`while` loop), when `dump_logs_on_failure` is not set, still surface the **tail of
the logs for the containers that actually failed**, so the error is visible by
default. Keep the full dump behind the flag.

### Sketch (against current `master`)

```python
        # Falls through if the while loop doesn't exit via break.
        click.echo()
        with tempfile.NamedTemporaryFile(suffix=".log", delete=False) as log_file:
            ret = subprocess.run(
                base_command + ["logs"],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                check=True,
                env=_docker_subprocess_env(),
            )
            log_file.write(ret.stdout)

        if dump_logs_on_failure:
            click.echo("Dumping docker compose logs:")
            click.echo(pathlib.Path(log_file.name).read_text())
            click.echo()
        else:
            # Even without --dump-logs-on-failure, surface *why* it failed:
            # print the tail of the logs for each unhealthy/errored container so
            # the root cause (e.g. a required env var) is visible by default.
            for container in status.errored_containers():   # new helper on the status object
                tail = subprocess.run(
                    base_command + ["logs", "--tail", "20", container],
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    env=_docker_subprocess_env(),
                ).stdout.decode(errors="replace")
                click.secho(f"\n----- last logs: {container} -----", fg="yellow")
                click.echo(tail)
            click.secho(
                "Re-run with --dump-logs-on-failure for the full compose logs.",
                fg="yellow",
            )

        raise status.to_exception(
            header="Unable to run quickstart - the following issues were detected:",
            footer="If you think something went wrong, please file an issue at https://github.com/datahub-project/datahub/issues\n"
            "or send a message in our Slack https://datahub.com/slack/\n"
            f"Be sure to attach the logs from {log_file.name}",
        )
```

`errored_containers()` is a small addition to the quickstart-status class
(the object returned by `check_docker_quickstart()`), returning the names of
containers that are not-running / exited / unhealthy — data it already tracks
to build the "the following issues were detected" list.

## Why this is the right scope

- **Minimal + safe:** no behavior change on success; only enriches the failure path.
- **Broadly useful:** helps *every* quickstart failure (OOM, port conflicts, the signing-key case), not just ours.
- **Directly closes #18594**, whose entire complaint is the opaque message.

## Optional follow-up (separate PR)

A pre-launch version-skew warning comparing the CLI version to the resolved
image tag (see issue, fix #2). Kept separate to keep this PR focused.

## Test plan

- Force a failure (e.g. unset a required env var / bad image tag) and confirm the
  failing container's log tail is printed by default and points at the real error.
- Confirm `--dump-logs-on-failure` still prints the full logs.
- Confirm a healthy quickstart is unaffected.
