# Msgzle

A minimal TypeScript SDK and self-hosted iMessage bridge built on Photon's MIT imessage-kit.

Early developer preview, not production-ready. A Mac signed into Messages is required. Your Linux server can host the relay; it cannot replace that Mac.

## What is here

- Small TypeScript client: health, text send, command status and queued cancellation.
- Durable command IDs, recipient allowlists and sending disabled by default.
- Mac menu-bar app, embedded Bun service and native General/Advanced Settings.
- Optional personal-cloud relay with outbound Mac polling. No public Mac port.
- GitHub Actions Mac packaging and Sparkle-signed update feed plumbing.

No receive, history, attachments, group creation, AI replies or multi-user hosting in v0. Secrets stay in the owner's private config, never in this repository.

## Install on a Mac

Release packaging targets both Intel (x64) and Apple Silicon (arm64) Macs. Download your matching DMG from GitHub Releases when published, drag Msgzle to Applications and open it. macOS 13 or newer is the build target; supported-version and permission testing is not complete.

The release pipeline requires Developer ID signing, Apple notarization and stapling, strict codesign verification and Gatekeeper checks before it uploads artifacts. No startup item is installed automatically. A private Intel/macOS 26.7.1 build has been launched and an owner-reviewed text send succeeded. Clean-install release permission behavior, ARM runtime and a second-version automatic update are not yet verified.

Open Settings from the menu bar. Reveal/Copy the generated API key in Advanced for SDK clients. Add selected recipients or explicitly choose Everyone before enabling sends. Contacts suggestions stay local and require permission; manual entry works without it. Launch at login and notifications are optional user-selected controls. Messages must already be signed in. The first reviewed send may trigger an Automation permission prompt. This v0 does not request Full Disk Access or enable receive.

## TypeScript client

The npm name is not yet published. Build/install the SDK from this repository for now.

```ts
import { Msgzle } from 'msgzle';
const client = new Msgzle({ baseUrl: 'http://127.0.0.1:19791', token: process.env.MSGZLE_TOKEN! });
// A send has real effects. Review the recipient and text in your application first.
const command = await client.send({ id: crypto.randomUUID(), to: '+15551234567', text: 'Hello' });
console.log(await client.command(command.id));
```

Reuse an ID only for the same intended command. A timeout after possible dispatch becomes `uncertain`. Never treat `dispatch-accepted` as delivered. There is no exactly-once recipient-delivery guarantee. A disconnected connector may leave a relay command `attempting`; it is not automatically requeued.

## Own cloud

`docker compose up --build` prepares a relay bound to server loopback. Persistent state lives in the named volume. Put your own authenticated HTTPS reverse proxy in front; this project does not create DNS or tunnels. Set `MSGZLE_ORIGIN` to the exact external origin. Protect the setup page and service. Store the relay's connector token through Advanced > Cloud relay > Set up, and use its separate app token for SDK calls. Both relay and Mac must allow the recipient. Do not expose unencrypted HTTP.

## Develop

Use Bun 1.3.0. Run `bun install --frozen-lockfile --ignore-scripts`, `bun scripts/patch-photon.mjs`, `bun run check`, `bun run build`, and `bun test`. Start the cloud role with `MSGZLE_ROLE=relay bun packages/server/src/server.ts`.

Photon is pinned at 3.0.0. It internally retries AppleScript by default. Our checked build-time patch changes that policy to one attempt and fails if the audited source shape changes. Upstream code and license are retained. Do not bump Photon blindly.

## Updates and releases

The Mac app includes Sparkle 2.10.0. Generate one Ed25519 seed, keep it private as `SPARKLE_PRIVATE_KEY`, and set the matching `SPARKLE_PUBLIC_KEY` repository variable. Never commit the private key. The tag-triggered release build signs update archives, verifies each signature against the app's public key, and uploads the notarized packages. Missing signing keys stop the build. Developer previews are prereleases. Per-architecture feeds are published in this repository only after release assets are public. SHA-256 files accompany the DMG and ZIP assets.

Automatic update installation is not yet verified end to end. It requires a signed second release and a Mac upgrade test. Apple Developer ID signing is separate from Sparkle signature verification. Dependency patches go through CI/review, not unattended npm-latest installation. Releases must preserve the pinned signing key; future versions need their version/build/feed metadata bumped together.

## Central platform alpha (local branch)

`packages/platform` contains the first local slice of the optional hosted Central model: Google and Apple OIDC sign-in, device pairing, app registration, a user grant for `messages.send`, an encrypted send queue, outbound Mac polling, and status reporting. Both providers use authorization-code sign-in with PKCE, state, nonce and provider JWKS validation. Central creates 30-day sessions only after the provider callback completes; sign-in starts are rate limited. Central stores encrypted envelopes only; recipient and message text are decrypted on the paired Mac, which still applies sending-off and recipient allowlist policy before dispatch. Receive, history, attachments, hosted deployment, and npm publication are not part of this slice.

The Mac Settings app includes an experimental **Msgzle Central** setup under Advanced. It opens Google or Apple sign-in in the browser, polls the local admin API for completion, starts pairing, displays the one-time pairing code, and approves that code for the signed-in user. The user session stays in app memory; only the Central URL, device token, and device private key are saved in the existing 0600 local config. For local development, `createCentral({ allowLocalSignup: true })` can still create test user tokens; do not enable that outside local development. The existing local and self-hosted relay modes remain supported.

Google sign-in is configured with `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI`. Apple sign-in is configured with `APPLE_CLIENT_ID`, `APPLE_REDIRECT_URI`, and either `APPLE_CLIENT_SECRET` or the `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY` values used to generate the required client-secret JWT. Both redirect URIs must exactly match the provider console values and point to this service's `/v1/auth/<provider>/callback` endpoints.

## License

MIT for Msgzle. Photon retains its MIT notice in `docs/PHOTON-LICENSE.txt`. Sparkle retains its own license in packaged builds. Other dependency licenses remain in their distributions. Msgzle is not affiliated with Apple or Photon.
