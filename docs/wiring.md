# Hardware and wiring

The detector runs on **most ESP32 and ESP32-S3 boards with a microphone that
ESPHome supports** — an external I²S or PDM microphone module, or a board with a
built-in microphone. It needs the ESP-IDF framework, a 16 kHz microphone and no
PSRAM. The studio and the `asd` tool generate the configuration for the boards
below; anything else is a matter of adapting the `microphone:` block (see
[Other microphones](#other-microphones-and-boards)).

## What has been tested

| Hardware | Status |
|---|---|
| M5Stack Stamp S3 + INMP441 (wiring below) | **Reference.** Runs the detector for a real Thermomix TM6 in daily use; recording firmware verified. |
| M5Stack CoreS3 SE (built-in microphones) | Verified end to end with a test alarm played from a speaker: recording firmware, preset built from the recording, on-device detection, no false alarms in silence. Not yet with a real appliance. |
| Everything else in this page | Expected to work (standard ESPHome microphone configuration) but **not verified by the project** — please report how it works. |

Supported chips: ESP32 and ESP32-S3 (both have the floating-point unit the
detector uses). ESP32-C3 / C6 / H2 are untested.

## Choose a microphone

| Microphone | Type | Notes | Studio / `asd` preset |
|---|---|---|---|
| **INMP441** | I²S MEMS breakout | Cheap, very common, good sensitivity; 3.3 V. The project's reference microphone. | `stamp-s3` (wired as below) or `i2s` |
| **ICS-43434** | I²S MEMS breakout | INMP441's successor (same pinout family, flatter response); 3.3 V. | `i2s` |
| **SPH0645LM4H** (Adafruit breakout) | I²S MEMS | Reported to work with ESPHome's 32-bit I²S setting; SEL chooses the channel like L/R. Slightly noisier than INMP441. | `i2s` |
| **MSM261S4030H0** | I²S MEMS breakout | Same wiring as INMP441. | `i2s` |
| **SPM1423 / MP34DT05** | PDM MEMS | Two signal pins (CLK, DATA). Built into many boards. | `pdm` |
| Built-in: **M5Stack CoreS3 / CoreS3 SE** | ES7210 audio ADC | Nothing to wire. | `cores3` |
| Built-in: **Seeed XIAO ESP32S3 Sense** | PDM (on the Sense board) | Nothing to wire; CLK GPIO42, DATA GPIO41. | `xiao-s3-sense` |
| Built-in: **M5Stack Atom Echo** | PDM (SPM1423), ESP32 | Nothing to wire; CLK GPIO33, DATA GPIO23. | `atom-echo` |

Analog microphones (MAX4466, MAX9814 and similar on the ADC) are not
recommended: the ESP32's ADC is noisy and ESPHome's I²S microphone component
is the supported path.

## Example wiring: Stamp S3 + INMP441 (the reference)

This is just one example — any free GPIOs work; enter them in the studio's
device settings (generic `i2s` preset) or in the YAML `substitutions`.

![Wiring diagram](../assets/wiring.svg)

| INMP441 | Stamp S3 |
|---|---|
| VDD | 3V3 |
| GND | GND |
| SCK | GPIO1 |
| WS | GPIO7 |
| SD | GPIO5 |
| L/R | GND (left channel) |

If you tie L/R to 3V3 instead, use `channel: right`.

## Other I²S and PDM microphones

**I²S MEMS microphones** (INMP441, ICS-43434, SPH0645, MSM261…) have the same
signals under slightly different names:

| Signal | Also called | Connect to |
|---|---|---|
| VDD / 3V | VIN | 3V3 |
| GND | | GND |
| SCK | BCLK, CLK | any free GPIO (`SCK / BCLK pin`) |
| WS | LRCL, LRCLK | any free GPIO (`WS / LRCLK pin`) |
| SD | DOUT, DATA | any free GPIO (`SD / DOUT pin`) |
| L/R | SEL | GND → left channel, 3V3 → right channel |

**PDM microphones** have only `CLK` and `DATA` (plus power): set them as the
`CLK pin` and `DATA pin` of the generic `pdm` preset. If the level stays near
silence, switch the channel (left ↔ right).

Avoid pins with special roles on your board (strapping pins such as GPIO0,
GPIO45/46 on the S3; flash/PSRAM pins; on the classic ESP32 GPIO6–11). Check
your board's pinout.

## Other microphones and boards

Anything ESPHome can use as a **16 kHz** microphone works: generate the YAML
with the closest preset and replace the `i2s_audio:` / `microphone:` blocks
following ESPHome's documentation:

- [I²S Audio Microphone](https://esphome.io/components/microphone/i2s_audio/) —
  I²S and PDM microphones, channels, bit depth, DC offset correction.
- [Audio ADC](https://esphome.io/components/audio_adc/) — boards with an audio
  codec (ES7210, ES8311, …), e.g. ESP32-S3-BOX-3.
- [devices.esphome.io](https://devices.esphome.io/) — pinouts of many ready-made
  boards with microphones.

Keep the microphone's `id: mic` (the detector and the recording firmware refer
to it) and `sample_rate: 16000`.

**Checking a new setup:** install the temporary recording firmware and run
`asd record --seconds 5` (or record a clip on the device's page) while someone
talks: the peak should be above about −45 dBFS. Near-silence means wrong pins
or the wrong channel.

## Placement

- Put the device **where it will finally listen** before recording examples:
  same room, similar distance to the appliance. Recordings made elsewhere
  sound different (room echo, distance) and make a weaker preset.
- Within 1–2 m of the appliance's speaker with a clear line of sight works
  best; avoid placing it directly next to an extractor hood, sink or kettle.
- Keep it away from heat and steam (MEMS microphones and ESP32 boards are not
  splash-proof). A small enclosure with an opening for the microphone port
  works well.
- One device can listen for several appliances if it hears all of them
  clearly; appliances in other rooms need their own device.
- Power: a 5 V USB supply; the device is meant to be mains powered (Wi-Fi power
  saving is off).
