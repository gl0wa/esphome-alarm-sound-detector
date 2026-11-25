# Home Assistant integration

The detector runs entirely on the ESP32. Home Assistant only receives entity
states through the encrypted ESPHome native API; no audio ever leaves the device
in the normal (non-dev) firmware.

## 1. Add the device

1. Flash the firmware (see the main README) and power the device.
2. In Home Assistant open **Settings → Devices & services**. The device appears
   as *Discovered* (ESPHome, e.g. `thermomix-detector`). Click **Add** / **Configure**.
3. Paste the **API encryption key**: the `api_encryption_key` value from your
   `firmware/secrets.yaml`.

If it is not discovered (mDNS blocked between VLANs), use **Add integration →
ESPHome** and enter the device's hostname or IP address, port `6053`.

## 2. Entities

With `friendly_name: Thermomix Detector` the entities are:

| Entity | Meaning |
|---|---|
| `binary_sensor.thermomix_detector_thermomix_alarm` | **ON** while the appliance alarm is ringing (after 2 matching repetitions; turns OFF ~7 s after the last one). |
| `sensor.thermomix_detector_alarm_match_score` | Template match score (0–1). Published immediately for every repetition (≥ `threshold`) and near miss (≥ `near_threshold`); otherwise the maximum seen in each `report_interval` (default 60 s). Useful to watch for near-threshold false positives in the history graph. |
| `sensor.thermomix_detector_sound_level_rms` / `_peak` | Microphone level diagnostics (dBFS). |
| Wi-Fi signal, uptime, chip temperature, reset reason, firmware version | Diagnostics. |

Entity IDs depend on your `friendly_name` and entity names; check
**Settings → Entities** if yours differ.

## 3. Notification: "notify my phone if it is still ringing"

A blueprint is provided:
[`homeassistant/blueprints/automation/alarm_sound_detector/notify_when_still_ringing.yaml`](../homeassistant/blueprints/automation/alarm_sound_detector/notify_when_still_ringing.yaml)

Behaviour:

- Waits until the alarm sensor has been **ON continuously for `delay`** (default
  20 s). If you acknowledge the appliance sooner, nothing is sent.
- Sends a high-priority push notification through the Home Assistant Companion
  app (`mobile_app` device).
- Optionally repeats it every `reminder_interval` while still ringing (default 0 = off).
- **Clears** the notification when the alarm stops.

### Import

- Copy the file to `<config>/blueprints/automation/alarm_sound_detector/` and
  reload blueprints (**Settings → Automations & scenes → Blueprints → ⋮ → Reload**), or
- use **Import blueprint** with the raw GitHub URL of the file once the repository
  is published.

Then **Create automation** from it and pick the alarm sensor and your phone.

### Configuration options

| Input | Default | Notes |
|---|---|---|
| Alarm binary sensor | – | e.g. `binary_sensor.thermomix_detector_thermomix_alarm` |
| Phone | – | A device of the *Mobile App* integration |
| Notify only if still ringing after | 20 s | Set to 0 to notify as soon as the alarm is confirmed |
| Reminder interval | 0 (off) | e.g. 2 min to keep reminding while it rings |
| Title / Message | "Thermomix" / "The Thermomix needs your attention." | |
| Notification tag | `appliance_alarm_thermomix` | Must be unique per appliance; used to replace and clear |
| Android notification channel | `Appliance alarms` | On Android, long-press the notification → settings to give this channel its own sound / override Do Not Disturb |

To change settings later: **Settings → Automations & scenes**, open the
automation, edit the inputs, **Save**.

### Without the blueprint

Equivalent plain automation (replace the entity and `notify.mobile_app_…` service):

```yaml
alias: Thermomix alarm – notify if still ringing
mode: single
triggers:
  - trigger: state
    entity_id: binary_sensor.thermomix_detector_thermomix_alarm
    to: "on"
    for: { seconds: 20 }          # <- delay before notifying
actions:
  - action: notify.mobile_app_your_phone
    data:
      title: Thermomix
      message: The Thermomix needs your attention.
      data: { tag: appliance_alarm_thermomix, channel: Appliance alarms, priority: high, ttl: 0 }
  - wait_for_trigger:
      - trigger: state
        entity_id: binary_sensor.thermomix_detector_thermomix_alarm
        from: "on"
  - action: notify.mobile_app_your_phone
    data:
      message: clear_notification
      data: { tag: appliance_alarm_thermomix }
```

## 4. Testing

Trigger a short appliance timer (e.g. a 10 s TM6 timer) and leave the alarm
ringing for longer than the configured delay. Within ~6 s of the first clean
chime the binary sensor turns ON; after `delay` the notification arrives; it
disappears ~7 s after you acknowledge the appliance. Acknowledge before the delay
to confirm that no notification is sent.

## 5. Tuning the detector

Detector options live in the ESPHome YAML (`alarm_sound_detector:` block):
`threshold` (default 0.55), `near_threshold` (0.35), `min_repetitions` (2),
`period` / `period_tolerance`. See
[`components/alarm_sound_detector/README.md`](../components/alarm_sound_detector/README.md).
Watch the match-score history for a few days: scores of near misses that come
close to `threshold` are the signal to adjust it (or to rebuild the template with
more examples).
