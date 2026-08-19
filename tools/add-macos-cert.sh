# Imports the Developer ID certificate into a throwaway CI keychain and exports
# APPLE_KEYCHAIN + APPLE_SIGNING_IDENTITY for later steps. Sourced (not executed)
# by the release workflow on macOS runners. Same convention as codesplash-ai-app.
# Based on https://github.com/electron/fiddle/blob/c3f3e9cc30a2341970575e27a7117a71e56e0b2a/tools/add-macos-cert.sh
#!/usr/bin/env bash

set -eo pipefail

KEY_CHAIN="${RUNNER_TEMP:-$PWD}/build.keychain-db"
MACOS_CERT_P12_FILE=certificate.p12

if [ -n "$MACOS_CERT_P12" ]; then
  echo "MACOS_CERT_P12 is set. Length: ${#MACOS_CERT_P12}"
else
  echo "MACOS_CERT_P12 is not set."
fi

# Recreate the certificate from the secure environment variable
echo -n "$MACOS_CERT_P12" | base64 -d > "$MACOS_CERT_P12_FILE"
echo "Certificate size is $(stat -f%z "$MACOS_CERT_P12_FILE") bytes"

# Create a keychain
security create-keychain -p actions "$KEY_CHAIN"
security set-keychain-settings -lut 21600 "$KEY_CHAIN"

# Make the keychain the default so identities are found
CURRENT_DEFAULT_KEYCHAIN="$(security default-keychain -d user | tr -d '"')"
if [ -n "$CURRENT_DEFAULT_KEYCHAIN" ]; then
  security list-keychains -d user -s "$KEY_CHAIN" "$CURRENT_DEFAULT_KEYCHAIN"
else
  security list-keychains -d user -s "$KEY_CHAIN"
fi
security default-keychain -s "$KEY_CHAIN"

# Unlock the keychain
security unlock-keychain -p actions "$KEY_CHAIN"

# The latest Developer ID Intermediate Certificate from Apple is
# missing on GitHub Actions (?), but we need it for the cert to be valid
curl https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer -o DeveloperIDG2CA.cer
sudo security add-trusted-cert -d -r unspecified -k "$KEY_CHAIN" DeveloperIDG2CA.cer
rm -f DeveloperIDG2CA.cer

security import "$MACOS_CERT_P12_FILE" -k "$KEY_CHAIN" -P "$MACOS_CERT_PASSWORD" -A -T /usr/bin/codesign -T /usr/bin/security -T /usr/bin/xcrun

security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k actions "$KEY_CHAIN"

security show-keychain-info "$KEY_CHAIN"
security find-identity -v -p codesigning "$KEY_CHAIN"

SIGNING_IDENTITY_HASH="$(security find-identity -v -p codesigning "$KEY_CHAIN" | awk '/Developer ID Application:/ {print $2; exit}')"
if [ -n "$GITHUB_ENV" ]; then
  {
    echo "APPLE_KEYCHAIN=$KEY_CHAIN"
    echo "APPLE_SIGNING_IDENTITY=$SIGNING_IDENTITY_HASH"
  } >> "$GITHUB_ENV"
fi

# remove certs
rm -fr *.p12
