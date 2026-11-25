#!/usr/bin/env bash
# Load every bundled preset through ESPHome's own config validation
# (the component's codegen loader), using the public example as the base.
set -euo pipefail
cd "$(dirname "$0")/../.."
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
printf 'wifi_ssid: "ci"\nwifi_password: "ci-password"\napi_encryption_key: "%s"\n' \
  "$(head -c32 /dev/urandom | base64)" > "$work/secrets.yaml"
ids=$(python3 -c 'import json,sys; print(" ".join(p["id"] for p in json.load(open(sys.argv[1]))["presets"]))' \
  components/alarm_sound_detector/presets/index.json)
fail=0
for id in $ids; do
  sed -e "s|- source: github://gl0wa/esphome-alarm-sound-detector@main|- source: { type: local, path: $PWD/components }|" \
      -e "s|template: [a-z0-9_]*|template: $id|" \
      examples/stamp-s3-inmp441-thermomix-tm6.yaml > "$work/$id.yaml"
  if esphome config "$work/$id.yaml" > "$work/$id.log" 2>&1; then
    echo "OK   $id"
  else
    echo "FAIL $id"; tail -20 "$work/$id.log"; fail=1
  fi
done
exit $fail
