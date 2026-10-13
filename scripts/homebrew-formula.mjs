import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const checksum = arch => readFileSync(join(root, 'artifacts', `dscode-${version}-darwin-${arch}-standalone.tar.gz.sha256`), 'utf8').split(/\s+/)[0];
const arm = checksum('arm64'), intel = checksum('x64');
if (![arm, intel].every(value => /^[a-f0-9]{64}$/.test(value))) throw Error('Build and checksum both platform packages first.');
const formula = `class Dscode < Formula
  desc "Self-contained DSCODE coding agent"
  homepage "https://github.com/qiz029/dscode"
  version "${version}"
  license "MIT"
  depends_on :macos

  on_arm do
    url "https://github.com/qiz029/dscode/releases/download/v${version}/dscode-${version}-darwin-arm64-standalone.tar.gz"
    sha256 "${arm}"
  end
  on_intel do
    url "https://github.com/qiz029/dscode/releases/download/v${version}/dscode-${version}-darwin-x64-standalone.tar.gz"
    sha256 "${intel}"
  end

  def install
    libexec.install Dir["*", ".dscode-standalone.json"]
    (libexec/".dscode-brew").write "Homebrew owns this application package.\\n"
    bin.install_symlink libexec/"dscode"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/dscode --version")
    assert_match "native modules OK", shell_output("#{bin}/dscode --check")
  end
end
`;
writeFileSync(join(root, 'artifacts/dscode.rb'), formula);
console.log('artifacts/dscode.rb');
