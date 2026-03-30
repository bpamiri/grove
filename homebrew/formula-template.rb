class Grove < Formula
  desc "Conversational AI development orchestrator"
  homepage "https://github.com/bpamiri/grove"
  version "__VERSION__"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/bpamiri/grove/releases/download/v__VERSION__/grove-darwin-arm64.tar.gz"
      sha256 "__SHA_DARWIN_ARM64__"
    else
      url "https://github.com/bpamiri/grove/releases/download/v__VERSION__/grove-darwin-x64.tar.gz"
      sha256 "__SHA_DARWIN_X64__"
    end
  end

  on_linux do
    url "https://github.com/bpamiri/grove/releases/download/v__VERSION__/grove-linux-x64.tar.gz"
    sha256 "__SHA_LINUX_X64__"
  end

  def install
    bin.install "grove"
  end

  test do
    assert_match "grove", shell_output("#{bin}/grove --version")
  end
end
