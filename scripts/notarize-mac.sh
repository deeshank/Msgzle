#!/bin/bash
set -euo pipefail
arch="${1:?arm64 or x64}"
: "${APPLE_ID:?}" "${APPLE_TEAM_ID:?}" "${APPLE_APP_PASSWORD:?}"
# Keep credentials out of command tracing and logs; CI masks secret values.
xcrun notarytool submit "build/Msgzle-$arch.zip" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait --timeout 20m --output-format json > build/notary-app.json
status=$(plutil -extract status raw build/notary-app.json)
[ "$status" = Accepted ] || { echo 'Apple app notarization rejected'; exit 1; }
xcrun stapler staple build/Msgzle.app
xcrun stapler validate build/Msgzle.app
codesign --verify --deep --strict --verbose=2 build/Msgzle.app
spctl --assess --type execute --verbose=4 build/Msgzle.app
rm -rf build/dmg
mkdir build/dmg
cp -R build/Msgzle.app build/dmg/Msgzle.app
ln -s /Applications build/dmg/Applications
hdiutil create -volname Msgzle -srcfolder build/dmg -ov -format UDZO "build/Msgzle-$arch.dmg"
codesign --force --timestamp --sign "$MSGZLE_SIGNING_IDENTITY" "build/Msgzle-$arch.dmg"
xcrun notarytool submit "build/Msgzle-$arch.dmg" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait --timeout 20m --output-format json > build/notary-dmg.json
status=$(plutil -extract status raw build/notary-dmg.json)
[ "$status" = Accepted ] || { echo 'Apple DMG notarization rejected'; exit 1; }
xcrun stapler staple "build/Msgzle-$arch.dmg"
xcrun stapler validate "build/Msgzle-$arch.dmg"
spctl --assess --type open --context context:primary-signature --verbose=4 "build/Msgzle-$arch.dmg"
rm "build/Msgzle-$arch.zip"
ditto -c -k --sequesterRsrc --keepParent build/Msgzle.app "build/Msgzle-$arch.zip"
shasum -a 256 "build/Msgzle-$arch.dmg" "build/Msgzle-$arch.zip" > "build/checksums-$arch.txt"
