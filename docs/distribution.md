# Self-contained package distribution

The terminal is distributed as one complete application archive per platform. Download `dscode-<version>-darwin-arm64-standalone.tar.gz` for Apple Silicon, `dscode-<version>-darwin-x64-standalone.tar.gz` for Intel Macs, or `dscode-<version>-linux-x64-standalone.tar.gz` / `dscode-<version>-linux-arm64-standalone.tar.gz` for Linux. Each archive contains its own Node 24.21.0, pinned Harness, compiled TUI, plugins and native modules. No system Node, npm, pnpm or DSH is needed, and first launch does not download runtime dependencies.

macOS 14+ and 64-bit Linux with glibc (x64 and arm64) are supported. The Linux packages bundle glibc builds of Node and the native modules, so musl distributions such as Alpine cannot run them; the installer refuses them. Git is used for repository and patch operations. Google Chrome and macOS Accessibility/Screen Recording permission are needed only for the features that use them.

On Linux, commands run inside bubblewrap; install it with your package manager (`apt install bubblewrap`, `dnf install bubblewrap`). Without it the sandbox falls back to Landlock, and when neither is usable sandboxed commands are refused rather than run unconfined. Clipboard image paste, Computer Use and the Desktop package remain macOS-only. `dscode trigger install` prints the equivalent crontab line to add instead of loading a launchd agent. Homebrew covers macOS only; on Linux use the installer or a direct download. Models, external MCP servers and project tools retain their own configuration and requirements.

## Download and run

```sh
mkdir dscode-app
tar -xzf dscode-0.7.47-darwin-arm64-standalone.tar.gz -C dscode-app
./dscode-app/dscode
```

Keep the extracted directory together. `dscode` is the executable entry; its private runtime and libraries are siblings inside that directory. You can move the complete directory while no session is running. User data does not move with it.

The optional installer downloads and verifies the same package:

```sh
curl -fsSL https://raw.githubusercontent.com/qiz029/dscode/main/install.sh | sh
# Pin an exact release:
curl -fsSL https://raw.githubusercontent.com/qiz029/dscode/main/install.sh | sh -s -- 0.7.47
# Or install an already unpacked package, without a download:
sh dscode-app/install.sh
```

The installer uses standard system shell tools, not Node. It selects the package from `uname` (macOS or Linux, arm64/aarch64 or x86_64), checks for glibc on Linux, and uses `shasum` or `sha256sum`, whichever the system provides. It verifies the published SHA-256 sidecar before extraction, checks the package with its private runtime, then installs it at `~/.local/share/dscode-app` and links `~/.local/bin/dscode`. Put that bin directory on PATH. Absolute `DSCODE_INSTALL_DIR` and `DSCODE_BIN_DIR` override those locations. An existing foreign command is never overwritten. Re-running the installer for a managed package delegates to its updater. Releases without a self-contained package or checksum are refused; there is no source/npm fallback.

## Existing DSH installations

DSCODE only installs a `dscode` command. It never creates or replaces global `dsh`, `node`, `npm` or `pnpm` commands. Runtime startup uses absolute package paths. The private Node directory is on PATH only inside DSCODE's process tree, so bundled helpers use the same runtime.

Inherited `DSH_*` variables, `NODE_OPTIONS` and `NODE_PATH` are removed before the application starts. DSCODE supplies its own `DSH_HOME` and `DSH_AGENTS_HOME`. Provider keys, proxies, custom CA certificates and the user's remaining tool PATH are preserved. Project-local instructions, hooks and skills remain supported; the standalone application excludes the global `~/.dsh/skills` ancestor root.

Sessions, native credentials, provider configuration, caches, user skills and local overrides live at `~/.local/share/dscode-state`, overridable with an absolute `DSCODE_HOME`. This directory must be outside the application and `~/.dsh`, including symlink aliases. Terminal preferences and input history use `tui/` under that directory. Shared DSCODE provider credentials use `credentials.yaml`; Harness-native credentials use `.credentials.yaml`. Custom services use `providers.yaml`; the mailbox uses `email/` unless `DSCODE_EMAIL_DIR` is explicitly set. Local overrides use `.env` and `config/hooks.local.json`, `config/mcp.local.yml` and `config/harness.local.yml` there.

The application does not import `~/.dsh` configuration, Hub tokens or the old `~/.dscode/credentials.yaml` automatically. Run `dscode --installation` to inspect the actual program, runtime and data locations. This isolation applies to the terminal package; the separate Desktop plugin deliberately runs inside its owning Desktop application.

## Upgrade and rollback

```sh
dscode update             # newest published self-contained release
dscode update 0.7.47      # an exact release, including an explicit rollback
```

Exit running DSCODE sessions and schedulers first. Startup and update share kernel admission locks; each running child retains protection even if its launcher is killed. Both the program location and the selected data directory are protected. Concurrent ordinary sessions from the same package remain supported. A different package must wait until those sessions exit before taking over the same data directory. The stable `dscode-app` profile preserves native model/settings edits in `cordis.patch.yml` across upgrades and package relocation. Generated application defaults live in a separate private base bundle under the data directory.

The updater downloads a matching platform archive from GitHub, requires its published SHA-256 digest, checks its version/platform and bundled modules, and only then swaps the complete program directory. A failed check leaves the old program in place; a failed swap or relocated check restores it. Successful updates retain a sibling `dscode-app.backup-<version>-<timestamp>` directory. State never enters the staged package and is not moved or rolled back. The directory swap has a brief rename interval; a new launch in that interval may need to be retried. This is not a filesystem transaction across power failure.

A default update never downgrades an application newer than the published release. An explicit version may downgrade only to another self-contained package; older source/prebuilt releases are refused. `/update` schedules this same updater after the TUI exits. Its version check uses GitHub, not npm.

Version 0.7.41 has an archive-listing buffer bug in its updater. Rerun the `curl` installation command once to repair that version using the new package's updater. The repair retains the same session locks, checksum checks and external user data. From 0.7.42 onward, use `dscode update` normally. Homebrew installations continue to use `brew upgrade dscode`.

## Migration from older DSCODE installations

Old installations remain usable. New archives have a `-standalone` suffix so an old updater refuses them instead of applying the wrong installation or state-migration procedure. Check `type -a dscode` and `dscode --version` before changing your command link; npm, Homebrew and source links may coexist. Install the new package in a separate program directory and remove or rename an old command link only after identifying its owner.

Migration is explicit, with all old sessions and schedulers stopped and a backup made first:

- An existing npm/Hub data directory can be selected with `DSCODE_HOME="$HOME/.local/share/dscode-hub"`. The standalone application creates its own stable `dscode-app` profile there and does not reuse the Hub-managed dependency graph. Transfer only the desired user overrides from the old profile into `profiles/dscode-app/cordis.patch.yml`; do not copy node_modules, generated plugin insertions or absolute paths to the old installation. Do not run legacy and standalone applications against the same data concurrently.
- For a tar/source installation, copy the old `.runtime` contents to a separate data directory, and copy only the desired `.env` and local `config/` overrides into it. Select that directory with `DSCODE_HOME`. To retain native model/settings edits, transfer only user overrides from the old `profiles/tui/cordis.patch.yml` into `profiles/dscode-app/cordis.patch.yml`; exclude generated plugin insertions and paths to the old installation. Keep the original until sessions have been checked. Do not point the new application at the old program directory.
- To retain shared provider logins, explicitly copy `~/.dscode/credentials.yaml` to `credentials.yaml` in the selected data directory if no destination credential file exists, preserving owner-only permissions. Native `.credentials.yaml` already lives in the old runtime data. Re-login instead if combining stores would be ambiguous.
- Custom service definitions in `~/.dscode/providers.yaml` and mail in `~/.dscode/email/` can be copied explicitly to `providers.yaml` and `email/` in the data directory. Keep the matching provider keys when migrating custom services.
- Old terminal UI preferences in `~/.dsh/dsh-code` can be copied explicitly to the new data directory's `tui/`; no other global DSH files need to be copied.

Automatic credential merging and conversion of future incompatible session schemas are not provided. Review a resumed session before discarding old data.

## Homebrew

The release build generates `artifacts/dscode.rb` from the exact two application archives and their checksums. The new formula installs the complete package into `libexec`, links only `dscode`, and has no Node/npm dependency. Its marker makes `dscode update` direct users to `brew upgrade dscode`; Homebrew replaces the whole package, never a separate Hub profile.

The maintained [qiz029/homebrew-tap](https://github.com/qiz029/homebrew-tap) uses this generated formula. Its daily and on-demand updater follows GitHub releases, verifies the formula digest and both archive checksums, and rejects incomplete releases before changing the tap. The repository build produces the formula; tap synchronization remains a separate publication step.

## Build and release

```sh
npm run dist                         # both platform archives plus SHA-256 sidecars
node scripts/homebrew-formula.mjs    # the matching formula
node scripts/verify-standalone.mjs   # qualify this machine's architecture
make release                        # full local terminal candidate gate
make publish                        # attach terminal assets to GitHub
```

`npm run dist` builds all four platforms. `DSCODE_PREBUILT_PLATFORMS` selects a comma-separated subset of `darwin-arm64`, `darwin-x64`, `linux-x64` and `linux-arm64` for development; the older `DSCODE_PREBUILT_ARCHS=arm64` or `x64` still selects macOS builds. An empty or unknown selection is an error. Linux packages are cross-built without running install scripts, from the prebuilt native modules each dependency publishes. Builds install the repository lockfile in a fresh staging directory, compile the TUI and apply runtime patches there, then add the official Node archive verified against checked-in SHA-256 hashes. They never copy a developer's node_modules, credentials or runtime state. Every runtime archive includes Node's license.

Release CI validates the ARM64 archive and downloads those exact candidates for separate Intel macOS, Linux x64 and Linux arm64 qualification on native runners; nothing is published unless all four pass. The Linux e2e workflow also builds and qualifies the Linux package for its container on every pull request. Verification covers an unusable foreign Node/npm/DSH on PATH, foreign DSH variables, an untouched global DSH home, native module imports and a real PTY, cold profile composition, local Host diagnostics and local installation. Native macOS permission UI and real model inference remain separate acceptance checks.

The default terminal release has no npm or Hub publication dependency. Desktop continues through its own package and verification path. Historical npm/Hub tooling remains documented in [Legacy Hub distribution](hub-distribution.md); it is not used to install or update the self-contained terminal.
