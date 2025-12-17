# OctoFlow Action

OctoFlow renders your workflow jobs as a Mermaid graph and job table in the run summary at the end of every job. It runs entirely inside the job (no external backend), relies on the built-in `GITHUB_TOKEN`, and keeps permissions tight.

## Usage

```yaml
jobs:
  visualize:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Render OctoFlow summary
        uses: octoflow/octoflow-action@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          title: OctoFlow pipeline
          artifact: true
```

- `artifact` defaults to `true` and writes `octoflow.json` for downstream workflows.
- `graph` currently supports only `mermaid`; the action will warn and fall back to Mermaid otherwise.
- `title` customizes the summary heading (defaults to `OctoFlow`).

## Inputs

- `github-token` (required): Token used for the GitHub Actions API. Pass `secrets.GITHUB_TOKEN` to keep things scoped inside the repo.
- `artifact` (optional): `true`/`false` flag to decide whether to upload the normalized `octoflow.json` artifact. Defaults to `true`.
- `graph` (optional): Graph format to render; only `mermaid` is supported today.
- `title` (optional): Heading text shown above the summary graph.
- `run-id` (optional): Override the workflow run ID that OctoFlow summarizes (useful when you call the action from a follow-up `workflow_run` workflow).

## Permissions

```yaml
permissions:
  contents: read
  actions: read
```

## Summary behavior

OctoFlow uses the `runs.main` entrypoint to capture input/state and the `runs.post` entrypoint to fetch the run/jobs/steps, build the Mermaid graph, and append markdown to `$GITHUB_STEP_SUMMARY`. Because it runs in a post hook, the summary only renders after the job completes and cannot be updated while steps are still running.

## Artifact

When `artifact: true`, OctoFlow writes a normalized `octoflow.json` (versioned payload with the run, jobs, steps, and workflow edges) and uploads it as the `octoflow` artifact. That payload can power custom viewers or be consumed by downstream workflows.

## Self-test

The `.github/workflows/self-test.yml` workflow runs on `push`/`workflow_dispatch`, builds the action locally, and exercises it via `uses: ./`. It includes a dummy failing step (with `continue-on-error: true`) so you can verify that the summary reflects both successes and failures after the job concludes.
