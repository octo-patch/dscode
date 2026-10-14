# Antigravity

DSCODE can use Gemini through a Google account with Antigravity access. This is a community model-provider integration, adapted from [pi-antigravity](https://github.com/Rahularya01/pi-antigravity/tree/d59d22bfebd9e44f2fd4a31bf5954a23fb9b043a), not a Google-supported API or an ACP connection. DSCODE keeps its own tools, permissions, conversation history and agent loop. The Antigravity application and CLI do not need to be running.

## Sign in

1. Run `/antigravity login` in DSCODE. It opens Google sign-in in your browser and waits in the background for up to five minutes.
2. Complete the browser authorization, then run `/antigravity` to check whether sign-in completed.
3. Run `/provider antigravity`. Use `/model` to choose Gemini and `/effort` to select one of that model's reasoning levels.

The authorization page uses Google's Antigravity installed-app client. It requests Cloud Code Assist/Antigravity, cloud-platform, profile, email, logging and configuration scopes. The callback listens only on `127.0.0.1:51121`; the browser returns to `http://localhost:51121/oauth-callback`. If another login occupies that port, finish or cancel it before retrying. On a remote machine, forward that loopback port to the computer running DSCODE before signing in. Authorization codes should not be pasted into a chat or command history.

The account must have an enabled Cloud Code Assist project. DSCODE checks the account's project information and project list; if neither returns a project, finish setup in Antigravity and retry. It does not invent a cloud project or provision a paid project.

## Commands

| Command | Result |
|---|---|
| `/antigravity` or `/antigravity status` | Read the stored login state and the result of the last sign-in attempt |
| `/antigravity login` | Start Google sign-in; an existing pending attempt is reused |
| `/antigravity models` | Refresh and display the Gemini catalog, or label the fallback catalog when discovery is unavailable |
| `/antigravity cancel` | Cancel the pending browser login |
| `/antigravity logout` | Remove this DSCODE login |

DSCODE stores its own access token, refresh token and project ID under `ANTIGRAVITY_OAUTH` in its credential store. For a self-contained terminal installation this is `$DSCODE_HOME/credentials.yaml`, normally `~/.local/share/dscode-state/credentials.yaml`, with owner-only permissions. Legacy installations retain their configured credential path. Tokens are refreshed automatically and are never placed in model prompts. Existing Pi, Gemini CLI and Antigravity CLI credential files are not read or modified. Logout removes the local copy; it does not revoke the grant at Google.

## Models and conversations

The fallback catalog contains Gemini 4 Argon (low/medium/high, default medium), Gemini 3.8, 3.7, 3.6 and 3.5 Flash (low/medium/high) and Gemini 3.1 Pro (low/high). This fallback is not evidence of account entitlement. After sign-in, DSCODE discovers the account's Gemini models and caches the list for five minutes in the current process. A successful discovery replaces the fallback, including when no supported Gemini model is returned. Known families retain their context and output limits; unknown discovered families use conservative limits unless the service supplies them. `/antigravity models` forces a refresh.

Gemini 4 models select reasoning with a thinking level rather than a token budget; Google documents that Argon rejects a budget. DSCODE sends `LOW`, `MEDIUM` or `HIGH` for the `/effort` you choose. Antigravity lists Argon as one runtime model per level, so, as with Flash, changing effort changes the runtime model. The service lists Argon only to Antigravity CLI 1.2.9 or later, which is the client identity DSCODE presents. Google currently limits Argon to Google AI Ultra and eligible Gemini Enterprise accounts, so it appears after discovery only for those accounts. Argon is not the default model.

Text, image attachments and screenshots from tools use DSCODE's durable attachment service. A catalog entry explicitly marked as text-only will not send image data. Signed thinking and tool-call metadata are kept with completed model responses and replayed to the same runtime model after a session resumes. On a provider, model or reasoning-level switch that changes the runtime model, earlier tool calls and their results are represented as historical text so incompatible signatures are not reused.

The initial integration offers Gemini only. It does not expose Antigravity's Claude/GPT models, image generation, Google Search grounding, account rotation or an Antigravity agent backend. DSCODE's existing web tools retain their own provider configuration; signing in here does not authorize those services. Ultra is not an advertised Gemini reasoning level.

## Failures and limits

The model request waits up to 30 seconds for response headers and up to 120 seconds without new stream data. Active streams may run longer. These limits are configurable through `headerTimeoutMs` and `streamIdleTimeoutMs` in the `dscode-antigravity` Host plugin. Cancellation closes the request; a missing completion marker or truncated tool response fails instead of committing a tool call. Transient errors use the existing Harness retry policy. A quota or authorization failure is not worked around by changing accounts or endpoints.

Model access and quotas are determined by Google for the signed-in account. DSCODE does not estimate a per-token price or promise that any specific subscription will permit a request. This transport depends on internal Cloud Code Assist endpoints and client request formats; server changes can require a compatibility update. HTTP diagnostics report status and error category without echoing response bodies or credentials. A revoked login requires `/antigravity login` again.

Automated verification uses synthetic token/model responses, the real loopback callback, the Harness provider registry, and a temporary credential store. Google consent, account entitlement and live model generation require verification with the user's account; automated tests do not establish those results.
