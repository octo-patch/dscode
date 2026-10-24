# DeepSeek account login

For the self-contained terminal, `DSCODE_HOME` defaults to `~/.local/share/dscode-state`. Legacy installations retain their previous paths; see [migration](distribution.md#migration-from-older-dscode-installations).

DSCODE can authenticate the DeepSeek route with a **DeepSeek account** instead of an API key. The sign-in happens in your system browser; the grant is stored on this machine and the model route picks it up automatically.

`/account` is the whole surface:

```
/account            status: is a grant stored, whose account it is, what the balance is
/account login      open the browser and complete a sign-in
/account cancel     abandon the sign-in that is in progress
/account logout     remove the grant from this machine
```

## What happens during a login

1. DSCODE asks the account service to start an attempt, passing a loopback callback origin (`http://127.0.0.1:<port>`) and identifying itself as a desktop client.
2. The service asks the platform to initialise the attempt with a PKCE challenge, then publishes the browser URL. DSCODE waits for that URL — it does not exist yet when the attempt is created — and only then opens the browser. If the browser cannot be launched, the URL is printed to open by hand.
3. You sign in on the platform page. The browser is redirected to `http://127.0.0.1:<port>/oauth/callback`, where the account provider validates the `state`, exchanges the code once, and commits the grant to the local credential store.
4. `/account` reports the outcome. A failure names a safe reason (unreachable platform, unexpected answer, timed out, credential store refused) and stores nothing.

The attempt is bounded on both sides: the platform's own expiry and DSCODE's five-minute wait. `Esc` (which cancels the command) or `/account cancel` in another turn ends it, and a cancelled attempt cannot be completed by a late callback.

## The callback server

The account provider registers `/oauth/callback` on the Host's HTTP server, so the TUI profile composes one: `@deepseek-ai/dsh-host-webserver` on `127.0.0.1` with an OS-assigned port. It listens for the whole session but carries **no routes except during a login attempt** — the callback route is added when an attempt starts and removed when it settles, and this profile mounts none of the Web shell's frontend or API rows. Requests to anything else answer 404, and a callback without a valid `state` and `code` answers 400.

Set `DSCODE_ACCOUNT_LOGIN=0` to remove the listener entirely. `/account login` then refuses with that reason instead of starting an attempt the browser could not complete; every other subcommand keeps working.

## What the login is worth

- **The DeepSeek route needs no API key.** The route resolves the account grant for the configured inference origin (`https://api.deepseek.com` by default) and sends it as the request credential. A `DEEPSEEK_API_KEY`, or a key stored through `/login`, keeps working and is what the route falls back to when no grant is stored.
- **A grant is scoped to one origin.** If you point the DeepSeek route at a proxy or another base URL, the account token is deliberately not sent there; use an API key for that route.
- **Identity and balance come from the platform**, not from DSCODE: `/account` prints the account name and masked contact, the recharge wallets and — separately — bonus wallets, and links to the platform's usage and top-up pages. Either read can fail on its own; the stored grant is kept when it does.

## Model discovery

In the terminal and server, both account login and the official API-key route follow DeepSeek's authenticated `/models` listing. The model picker includes supported listed models and uses their declared capabilities; DSCODE's Ultra effort remains available. Models that explicitly require a newer Harness are hidden and requests for them report an upgrade requirement.

With an API key, the first lookup waits for the listing for up to five seconds. Later lookups use the cached result and refresh it in the background after ten minutes. A failed initial lookup uses the bundled catalog; a failed refresh keeps the last successful listing. Changing or removing the key invalidates its cached listing. An exported `DEEPSEEK_API_KEY` still takes precedence over a stored key.

The API-key route follows the listing only at the official API origin with the built-in model configuration. A custom endpoint or an explicit model catalog keeps its configured models. The separate Desktop package remains on its older runtime and does not gain this API-key discovery behavior.

## Limits worth knowing

- **No expiry or refresh.** Upstream stores the grant without an expiry and has no refresh flow, so `credential-stored` means "this machine has a grant", not "the server still accepts it". A grant the platform has revoked surfaces as an authentication failure on the next model request; `/account logout` then `/account login` replaces it.
- **Sign-out is local first.** The grant is removed from this machine before the platform is told; a failed remote logout never restores the local login.
- **One attempt at a time.** Starting a second sign-in while one is in flight returns the running attempt rather than replacing it.
- **macOS and Linux open the browser** (`open` / `xdg-open`). On other platforms the URL is printed for you to open.

## Where the credential lives

In the same local credential store as your API keys (`$DSCODE_HOME/credentials.yaml`, `0600`), under the account provider's own record. It never reaches the model: account state is a client-safe projection with no token in it, tool results and session logs never carry it, and the command's output is redacted like every other DSCODE command result.
