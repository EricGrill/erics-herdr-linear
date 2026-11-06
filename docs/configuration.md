# Configuration

Everything on this page lives in one machine-local file that is deliberately kept out of
Git. It holds **key names and preferences, never key values** — see
[`config.example.json`](../config.example.json) for a complete sample.

- [Linear setup](#linear-setup) — API key, Doppler fallback, disabling enrichment
- [Attention rules](#attention-rules) — which states and labels mean *Needs you*
- [Cleanup rules](#cleanup-rules) — auto-close and its grace period

## Linear setup


Task dialogs and the sidebar use the configured Linear API key when available, including
the Doppler fallback below. This lets projects, ticket creation, and Crew share access
without a separate browser sign-in. Credential values remain inside the shell that sends
the request; they are never stored in layout preferences.

When no API key is available, task dialogs can use the existing `herdr-linear` OAuth
sign-in. Worktree operations use backend version **0.14.2**, with downloaded release
archives checked against upstream checksums.

The optional configuration file is:

```text
~/.config/herdr-app/erics-linear.config.json
```

For an environment variable with a different name:

```json
{
  "enrichment": {
    "envKey": "MY_LINEAR_API_KEY"
  }
}
```

For optional Doppler fallback:

```json
{
  "enrichment": {
    "enabled": true,
    "envKey": "LINEAR_API_KEY",
    "doppler": {
      "project": "your-project",
      "config": "dev",
      "keyNames": ["LINEAR_API_KEY"]
    }
  }
}
```

The environment variable is checked first. This file contains **key names**, never key
values. Authenticate your secret manager separately on each machine. Do not commit API
keys, OAuth tokens, or Herdr's `shared.json`, `view.json`, caches, and `data/` directory.

To use Spaces and the basic Linear adapter without enrichment, set
`"enrichment": { "enabled": false }`. Configuration is reread on Refresh and periodically;
a malformed file reports an error and retains the last good configuration/display.

## Attention rules

Spaces enter Needs you when Herdr reports an agent needing input or their linked ticket
has a configured attention state or label. Generic defaults include Needs Human, In
Review, Blocked, Awaiting Review, and Ready for Review; labels include `needs-human`,
`agent:review-needed`, `agent:check-result`, `agent:stalled`, and `reopened:not-done`.

You can replace either list in the same machine-local configuration:

```json
{
  "attention": {
    "labels": ["needs-human", "needs-my-review"],
    "states": ["needs human", "ready for review", "blocked"]
  }
}
```

These arrays replace their defaults. An empty array disables that category. Done rows
distinguish **Agent finished** from **Done in Linear**, so the two sources remain clear.

## Cleanup rules

Auto-close is on by default. Turn it off, or change the grace period, in the same
machine-local configuration:

```json
{
  "cleanup": { "autoClose": false, "graceMinutes": 10 }
}
```

A merged pull request alone never auto-closes a space; it only puts the space in Clean up.
Pin a space to keep it open after its ticket is done.

