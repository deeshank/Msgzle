# Msgzle 0.0.1 - developer preview

A minimal TypeScript SDK and self-hosted iMessage bridge built on Photon. This prerelease packages a Mac menu-bar app with its service embedded, an optional Linux relay, and a small setup page.

Choose Msgzle-x64.dmg for Intel or Msgzle-arm64.dmg for Apple Silicon. Drag Msgzle to Applications. No startup item is installed automatically. The pipeline requires Developer ID signing, Apple notarization and stapling, strict codesign verification and Gatekeeper checks before uploading packages. SHA-256 files accompany each architecture's DMG and ZIP.

Sends are off by default with an explicit recipient allowlist. Receive/history are not included. Dispatch accepted is not recipient delivery; uncertain sends are never blindly retried. No real messages were sent during build verification.

This is an early developer preview, not production-ready. First launch and macOS Automation permissions have not been tested. Sparkle update archives are signed and their signatures checked against the app's public key; repository-hosted update feeds are published after the release assets become public. A second-version upgrade has not been tested. Do not treat automatic update installation as proven yet. macOS 13 or newer is the build target, not a tested compatibility promise.
