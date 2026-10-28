# Anthropic

DSCODE calls the Anthropic Messages API directly with your API key. This uses Anthropic API billing; a Claude subscription does not supply an API key or pay these charges.

## Connect

1. Run `/login anthropic` and paste the key into the hidden input, or set `ANTHROPIC_API_KEY` in the environment that launches DSCODE.
2. Run `/provider anthropic`. The default model is Claude Opus 5.5.
3. Use `/model` to select a model and `/effort` to select reasoning effort.

The terminal stores the key in the shared, owner-only credentials file, normally `~/.local/share/dscode-state/credentials.yaml`. An environment key takes precedence and is read-only. `/login anthropic` can replace a saved key. Keys are not included in agent messages. `/provider claude` is an alias for `/provider anthropic`.

## Models

| Model | API ID | Context window | Maximum output | Default effort |
| --- | --- | --- | --- | --- |
| Claude Opus 5.5 | `claude-opus-5-5` | 1,000,000 | 128,000 | medium |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | 1,000,000 | 128,000 | high |
| Claude Fable 5.1 | `claude-fable-5-1` | 1,000,000 | 128,000 | high |

All three accept text and images, stream responses and use DSCODE tools. The list is built in, so it is visible before login and does not imply that the account has access to every model. Anthropic controls availability, quotas and billing. Model IDs and limits follow the [official model overview](https://platform.claude.com/docs/en/models/overview).

The route uses adaptive thinking and offers `low`, `medium`, `high`, `xhigh` and `max` effort. It requests summarized thinking and omits unsupported sampling parameters. Opus and Fable thinking cannot be disabled; this route also keeps adaptive thinking enabled for Sonnet. Auxiliary calls can request smaller output budgets than the maximum above.

## Conversation continuity

All three models default to automatic compaction at 50% of the usable input window. DSCODE reserves the 128,000-token output budget first: the usable window is 872,000 tokens, so pressure compaction becomes due at 436,000 measured tokens. Background summary prefetch starts at 348,800 tokens. Pruning may bring usage below the trigger without a summary; otherwise compaction runs at a safe step boundary. Explicit compaction threshold settings take precedence over this default.

DSCODE retains the original response content, including interleaved thinking, signatures and tool calls, for the next request. It returns tool results with their original call IDs. When the model, API key, system prompt, tools or preceding messages change, it removes thinking blocks whose saved prefix no longer matches. This includes local compaction. Text and tool calls remain available, but the model may need to reason again. See Anthropic's [preserved thinking rules](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking).

Incomplete streams fail without committing a partial assistant turn. HTTP failures retain status and retry delay without echoing API response bodies or credentials. This integration does not add Anthropic server-side search tools, automatic model discovery or Claude account login.
