# Template rendered by .github/workflows/release.yml ({{VERSION}} and {{SHA256_*}} substituted)
# and pushed to codesplash-ai/homebrew-tap as Formula/codesplash-agent.rb.
class CodesplashAgent < Formula
  desc "Terminal cockpit for Codex and Claude Code"
  homepage "https://github.com/codesplash-ai/codesplash-agent"
  version "{{VERSION}}"
  license "BUSL-1.1"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/codesplash-ai/codesplash-agent/releases/download/v#{version}/agent-#{version}-darwin-arm64.tar.gz"
      sha256 "{{SHA256_DARWIN_ARM64}}"
    else
      url "https://github.com/codesplash-ai/codesplash-agent/releases/download/v#{version}/agent-#{version}-darwin-x64.tar.gz"
      sha256 "{{SHA256_DARWIN_X64}}"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/codesplash-ai/codesplash-agent/releases/download/v#{version}/agent-#{version}-linux-arm64.tar.gz"
      sha256 "{{SHA256_LINUX_ARM64}}"
    else
      url "https://github.com/codesplash-ai/codesplash-agent/releases/download/v#{version}/agent-#{version}-linux-x64.tar.gz"
      sha256 "{{SHA256_LINUX_X64}}"
    end
  end

  def install
    bin.install "agent"
  end

  def caveats
    <<~EOS
      codesplash-agent drives the official provider CLIs; install and log in separately:
        Codex CLI 0.147.0:  npm i -g @openai/codex@0.147.0
        Claude Code:        https://code.claude.com
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/agent --version")
  end
end
