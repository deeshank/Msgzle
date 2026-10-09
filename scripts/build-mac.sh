#!/bin/bash
set -euo pipefail
: "${SPARKLE_PUBLIC_KEY:?Public update key required}"
arch="${1:?arm64 or x64}"
version=$(bun -e 'console.log(require("./package.json").version)')
build_number=${MSGZLE_BUILD_NUMBER:-1}
case "$arch" in arm64) target=bun-darwin-arm64;swift_target=arm64-apple-macos13.0;; x64) target=bun-darwin-x64;swift_target=x86_64-apple-macos13.0;; *) exit 1;;esac
mkdir -p build/vendor
curl --fail --location https://github.com/sparkle-project/Sparkle/releases/download/2.10.0/Sparkle-2.10.0.tar.xz -o build/vendor/Sparkle.tar.xz
printf 'c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c  build/vendor/Sparkle.tar.xz\n' | shasum -a 256 -c -
tar -xf build/vendor/Sparkle.tar.xz -C build/vendor
app=build/Msgzle.app
mkdir -p "$app/Contents/"{MacOS,Resources,Frameworks}
bun build packages/server/src/server.ts --compile --target="$target" --outfile "$app/Contents/Resources/msgzle-server"
cp -R build/vendor/Sparkle.framework "$app/Contents/Frameworks/"
swiftc macos/App.swift -target "$swift_target" -F build/vendor -framework Cocoa -framework Sparkle -Xlinker -rpath -Xlinker @executable_path/../Frameworks -o "$app/Contents/MacOS/Msgzle"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>in.msgzle.app</string><key>CFBundleName</key><string>Msgzle</string><key>CFBundleExecutable</key><string>Msgzle</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>$version</string><key>CFBundleVersion</key><string>$build_number</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>LSUIElement</key><true/><key>NSAppleEventsUsageDescription</key><string>Send only messages explicitly requested through your Msgzle service.</string>
<key>SUFeedURL</key><string>https://github.com/deeshank/Msgzle/releases/latest/download/appcast-$arch.xml</string><key>SUPublicEDKey</key><string>$SPARKLE_PUBLIC_KEY</string><key>SUEnableAutomaticChecks</key><true/><key>SUAllowsAutomaticUpdates</key><true/>
</dict></plist>
PLIST
cp LICENSE "$app/Contents/Resources/Msgzle-LICENSE.txt"
cp docs/PHOTON-LICENSE.txt "$app/Contents/Resources/Photon-LICENSE.txt"
cp build/vendor/LICENSE "$app/Contents/Resources/Sparkle-LICENSE.txt"
if [ -n "${MSGZLE_SIGNING_IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --entitlements macos/runtime.entitlements --sign "$MSGZLE_SIGNING_IDENTITY" "$app/Contents/Resources/msgzle-server"
  # Sparkle ships nested updater executables/frameworks; sign inside out.
  find "$app/Contents/Frameworks" -type f -perm +111 -print0 | while IFS= read -r -d '' file; do
    if file "$file" | grep -q 'Mach-O'; then codesign --force --options runtime --timestamp --sign "$MSGZLE_SIGNING_IDENTITY" "$file"; fi
  done
  find "$app/Contents/Frameworks" -depth -type d \( -name '*.xpc' -o -name '*.app' -o -name '*.framework' \) -print0 | while IFS= read -r -d '' bundle; do
    codesign --force --options runtime --timestamp --sign "$MSGZLE_SIGNING_IDENTITY" "$bundle"
  done
  codesign --force --options runtime --timestamp --sign "$MSGZLE_SIGNING_IDENTITY" "$app"
  codesign --verify --deep --strict --verbose=2 "$app"
else
  # Ad-hoc is not Developer ID and does not pass Gatekeeper trust.
  codesign --force --deep --sign - "$app"
fi
mkdir -p build/dmg
cp -R "$app" build/dmg/Msgzle.app
ln -s /Applications build/dmg/Applications
hdiutil create -volname Msgzle -srcfolder build/dmg -ov -format UDZO "build/Msgzle-$arch.dmg"
ditto -c -k --sequesterRsrc --keepParent "$app" "build/Msgzle-$arch.zip"
