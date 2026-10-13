# DSCODE release entry points.
#
# Every target mirrors a step of .github/workflows/release.yml, so the sequence can be
# rehearsed on this machine before a tag is pushed. The workflow remains the
# only path that publishes from CI; local terminal publication uses gh authentication.
#
#   make release    the build job: check, build the candidates, verify and pack them
#   make publish    attach the verified terminal packages; Desktop remains separate
#
# Terminal publication uses GH_TOKEN or gh login. Legacy/Desktop targets use npm and Hub credentials.

SHELL := /bin/sh
# Every phase consumes the artifacts of the one before it, so parallel prerequisites would
# reorder a release.
.NOTPARALLEL:
.DEFAULT_GOAL := help

VERSION := $(shell node -p "require('./package.json').version" 2>/dev/null)
TAG ?= v$(VERSION)
DESKTOP_RUNTIME ?= .research/desktop-release-runtime
DESKTOP_ASSETS = artifacts/desktop/release/*.tgz artifacts/desktop/release/*.sha256 artifacts/desktop/release/*-README.md artifacts/desktop/release/*-release-notes.md
# One self-contained application per platform, plus checksums and a matching tap formula.
TARBALLS := artifacts/dscode-$(VERSION)-darwin-arm64-standalone.tar.gz artifacts/dscode-$(VERSION)-darwin-x64-standalone.tar.gz artifacts/dscode-$(VERSION)-darwin-arm64-standalone.tar.gz.sha256 artifacts/dscode-$(VERSION)-darwin-x64-standalone.tar.gz.sha256 artifacts/dscode.rb

.PHONY: help install check version-check build verify candidates unpack release credentials publish publish-bundle publish-profile publish-launcher desktop publish-desktop attach

help:
	@echo 'DSCODE release targets (VERSION=$(VERSION)):'
	@echo '  make release            version-check, check, build, verify, candidates'
	@echo '  make publish            attach the verified self-contained terminal packages'
	@echo '  make install            npm ci --ignore-scripts'
	@echo '  make check              npm run check (lint, coverage, integration, package, eval)'
	@echo '  make version-check      TAG must match the manifest version (TAG defaults to v$(VERSION))'
	@echo '  make build              dist and the matching Homebrew formula'
	@echo '  make verify             verify the self-contained candidate for this machine'
	@echo '  make desktop            prepare and verify Desktop (requires DSCODE_TEST_CHROME)'
	@echo '  make publish-desktop    publish Desktop, sync Hub and verify public installation'
	@echo '  make candidates         pack release-candidates.tar.gz for a publish job'
	@echo '  make unpack             restore release-candidates.tar.gz into artifacts/'
	@echo '  make credentials        read-only npm and Hub credential check'
	@echo '  make publish-bundle     publish the bundle to npm'
	@echo '  make publish-profile    sync the Hub to npm, then publish the dscode profile'
	@echo '  make publish-launcher   publish the launcher to npm'
	@echo '  make attach             attach the self-contained packages to the GitHub release'

# The workflow installs with --ignore-scripts: the exact dependency set the release is
# verified against.
install:
	npm ci --ignore-scripts

check:
	npm run check

# A tag push publishes, so the tag has to name the version the manifest carries. Pass
# TAG=v0.7.15 to check another tag.
version-check:
	@version=$$(node -p "require('./package.json').version"); test "$(TAG)" = "v$$version" || { echo "tag $(TAG) does not match version $$version" >&2; exit 1; }; echo "tag $(TAG) matches version $$version"

build:
	npm run dist
	node scripts/homebrew-formula.mjs

verify:
	node scripts/verify-standalone.mjs

desktop:
	npm run prepare:desktop -- "$(DESKTOP_RUNTIME)"
	npm run release:desktop -- "$(DESKTOP_RUNTIME)"

# One tarball keeps the exact layout the publish job restores, artifacts/ prefix included.
candidates:
	tar -czf release-candidates.tar.gz artifacts/local/standalone-*.json $(TARBALLS)

# The publish job restores the candidates it downloaded and refuses an incomplete archive;
# locally this is also how a candidate tarball from another machine enters the tree.
unpack:
	@test -f release-candidates.tar.gz || { echo "release-candidates.tar.gz is missing; run make candidates" >&2; exit 1; }
	tar -xzf release-candidates.tar.gz
	@test -f artifacts/dscode.rb || { echo "the release candidate archive is incomplete" >&2; exit 1; }

release: version-check check build verify candidates

# Read-only: the npm token authenticates as the publishing user — NPM_PUBLISH_TOKEN, or the
# Keychain token scripts/npm-token.mjs stores for a login-free local release — the Hub token
# can read the dscode profile, and this version is still free on npm, so a forgotten version
# bump stops here. It reads the verification record, so run make release (or make unpack) first.
credentials:
	@test -n "$$DSH_HUB_TOKEN" || { echo "DSH_HUB_TOKEN is not set; see docs/hub-distribution.md" >&2; exit 1; }
	node scripts/check-publish-credentials.mjs
	npm run publish:desktop -- credentials

# Each phase re-checks the hashes verify:hub recorded: the launcher is never published before
# its bundle and its public Hub release resolve.
publish-bundle:
	npm run publish:hub -- bundle

publish-profile:
	npm run publish:hub -- profile

publish-launcher:
	npm run publish:hub -- launcher

publish-desktop:
	npm run publish:desktop -- npm
	npm run publish:desktop -- hub
	npm run publish:desktop -- verify
	npm run publish:desktop -- promote

# The tag always comes from the manifest version — the build job refuses a tag that does not
# name it — and the curl installer, `dscode update` and the README fetch these assets: the
# self-contained archives include Node and dependencies; there is no source fallback.
attach:
	@test -f "docs/releases/$(VERSION).md" || { echo "write the release notes first" >&2; exit 1; }
	@for tarball in $(TARBALLS); do test -f "$$tarball" || { echo "$$tarball is missing; run make build" >&2; exit 1; }; done
	@version=$(VERSION); if gh release view "v$$version" >/dev/null 2>&1; then gh release upload "v$$version" $(TARBALLS) --clobber; else test -f "docs/releases/$$version.md" || { echo "docs/releases/$$version.md is missing; write the release notes first" >&2; exit 1; }; gh release create "v$$version" $(TARBALLS) --title "DSCODE $$version" --notes-file "docs/releases/$$version.md"; fi

publish: attach
