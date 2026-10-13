# OpenAI and ChatGPT

DSCODE's native `openai` provider calls the Responses API and keeps DSCODE's own agent loop, tools, permissions and conversation storage. It supports either [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) for eligible plan usage or a separately billed OpenAI API key. It does not launch the Codex agent or connect through ACP.

## Sign in with ChatGPT

Command completion is available before the first conversation: type `/ope` to find `/openai`, with its supported arguments shown in the hint. Completion inserts the command name; enter the argument, such as `login`, yourself.

1. Run `/openai login` and complete **Continue with ChatGPT** in the browser. A loopback listener waits up to five minutes while the terminal remains usable.
2. Run `/openai status` to check the result and selected billing method.
3. Run `/provider openai`, then `/model` and `/effort` to choose an available model and reasoning effort. `/provider codex` is an alias.

DSCODE registers itself under its own name using OpenAI's dynamic public-client flow. It generates a stable host ID, PKCE verifier, state and OIDC nonce, then validates the returned identity token against OpenAI's JWKS. Returning sign-ins reuse the account's issued client ID. The browser callback uses `127.0.0.1`, an available local port, and `/auth/callback`. Remote terminals require port forwarding for that exact callback address. Do not paste authorization codes or tokens into the conversation.

The initial choice is ChatGPT plan usage. A missing permission or exhausted allowance stops the request; it never switches automatically to an API key. Use `/openai consent` to request plan-use permission for a saved registration. This flow depends on the account's plan, workspace policy and access granted to DSCODE. Review usage and access at [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage).

If `/openai status` reports `invalid_grant` during sign-in, run `/openai login` again and use the newly opened browser page. DSCODE retains the issued client ID as a pending registration and requests a fresh code with new PKCE and state values. The pending registration survives restart but is not a signed-in account; only verified credentials enable the provider. `/openai login new` deliberately starts another registration. Changing accounts or billing, or logging out, clears the pending retry. Do not reuse an earlier authorization URL.

## Use an API key

Run `/openai api-key` to select API billing, then `/login openai` to save the key in the masked terminal credential form. Alternatively, supply `OPENAI_API_KEY` in the environment that launches DSCODE. Run `/provider openai` after setup.

Switch back with `/openai use <client-id>` or `/openai login`. The current selection is saved across restarts. Account or billing switches cancel active OpenAI requests in this Host; other running Hosts use the updated selection for their next request.

## Speed and reasoning

`/speed` shows the requested tier, last confirmed tier and available choices for the selected model. Use `/speed standard`, `/speed fast` or `/speed ultrafast`; a running turn must stop before changing speed. `/effort` controls reasoning separately. For example, `high` reasoning and `ultrafast` speed can be combined when the model supports both.

The selected speed is recorded in the conversation and survives resume. The provider's `serviceTier` setting supplies the default for conversations without an explicit choice. The footer refreshes a changed selection even while idle, marks it unconfirmed before a completed response, and shows a change such as `fast → default` when the server reports a different tier. The connector never silently retries an unsupported tier at a different speed.

Fast and Ultrafast consume more usage or cost more. Model catalogs are not proof of entitlement. [OpenAI's speed documentation](https://learn.chatgpt.com/docs/agent-configuration/speed) describes current ChatGPT plan requirements; [API Fast](https://developers.openai.com/api/docs/guides/fast-mode) and [API Ultrafast](https://developers.openai.com/api/docs/guides/ultrafast-mode) describe API availability and billing. `priority` in a catalog is treated as the Fast tier.

## Context and model discovery

OpenAI conversations automatically compact at **272,000 estimated input tokens**, checked at step boundaries. The model's actual context window remains separate. If a smaller model's safe input budget requires an earlier trigger, that earlier threshold applies. The retained tail is scaled below the trigger, and the model-switch preview uses the same threshold. This is a local pressure policy, not a guarantee about server tokenization or billing.

The provider loads the selected account's model catalog from `/v1/models` and caches it for five minutes. `/openai models` refreshes it. Account changes clear the cache. Model context, modalities, reasoning options and service tiers use advertised metadata when present. The fallback entries for GPT-6.1 Sol and GPT-6 Astra use a 1,050,000-token context and a 128,000-token output reserve. Unknown discovered models without context metadata use a conservative 32,000-token context and 8,192-token output reserve. A successfully returned empty catalog stays empty; a failed discovery is labeled as such.

## Accounts and credentials

| Command | Behavior |
|---|---|
| `/openai login` | Sign in again to the selected registration, or create the first one |
| `/openai login new` | Register an additional account or workspace |
| `/openai accounts` | List saved registrations with distinct client IDs |
| `/openai use <client-id>` | Select a saved ChatGPT registration |
| `/openai consent` | Request plan-use permission for the selected registration |
| `/openai api-key` | Explicitly choose API billing |
| `/openai status` | Show selected billing and sign-in status |
| `/openai models` | Refresh and display model and speed choices |
| `/openai cancel` | Cancel browser sign-in |
| `/openai logout` | Revoke the selected renewable ChatGPT session and clear its local tokens |

The account file is `openai/accounts.json` beside the terminal's shared credential file: normally `$DSCODE_HOME/openai/accounts.json`, or `~/.dscode/openai/accounts.json` for legacy profiles. Desktop stores it under its DSH home. The file has owner-only permissions and is atomically replaced. A kernel lock serializes refresh, login, account changes and logout across processes. Registrations and the host ID remain after logout; access, refresh and retained ID tokens are removed. If remote revocation cannot be confirmed, the command says so. API keys remain in the existing credential store. Existing Codex credential files are not read or modified.

## Transport and verification limits

The connector uses HTTP/SSE at the public Responses endpoint, with a 30-second response-header timeout and a 120-second stream-idle timeout. `headerTimeoutMs` and `streamIdleTimeoutMs` in the `dscode-openai` plugin configure those limits. Active streams can last longer. Completed responses retain native reasoning items for replay to the same model and account; switching either prevents incompatible encrypted reasoning from being reused. Images use DSCODE's durable attachment service.

The ChatGPT direct route can omit the `Content-Type` header and return an empty output array in the final event. DSCODE parses the SSE body and retains complete `response.output_item.done` items for that case. A successful `response.completed` event is still required before any tool call is committed; partial deltas, interrupted streams and explicitly non-SSE responses are not treated as successful output.

ChatGPT plan requests follow the [preview restrictions](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations): stateless input history, `store: false`, `stream: true`, namespaced local tools, and no unsupported sampling or output-budget fields. Hosted OpenAI tools are not enabled. A stream must reach `response.completed` before any tool call is committed. Incomplete, failed and interrupted responses cannot execute a partially received tool call.

Automated tests use generated signing keys, local OAuth callbacks, temporary stores and synthetic model responses. Live Google or OpenAI credentials are not involved in those tests. Separate live checks with the installed binary verified repository edits, shell tests, file creation, persisted-session resume and terminal reporting. Fast and Ultrafast requests completed but the server reported Standard service for the tested account; these checks do not establish accelerated performance or other accounts' entitlement.
