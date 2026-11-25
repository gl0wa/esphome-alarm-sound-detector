# Preset parameters explained

Every preset describes **what the sound looks like** (frequency band, length,
template) and **how matches become an alarm** (threshold, rhythm, timing). The
[preset studio](https://gl0wa.github.io/esphome-alarm-sound-detector/) links each
setting to the section below. Names in `code` are the keys in the preset JSON
(`detection.*`) and the matching ESPHome YAML options, which override the preset.

How detection works, in one paragraph: every 16 ms the detector compares the last
*sound length* of audio, restricted to the *frequency band* and measured relative
to the background noise, with the preset's template. The result is a **match
score** between 0 (nothing alike) and 1 (identical). A peak above the
*threshold* counts as one **repetition**. Once enough repetitions arrive (at the
expected *period* for repeating alarms), the alarm turns on; it turns off after
*release* seconds without another repetition.

## Frequency band

`bin_lo` / `bin_hi` in the preset (shown in Hz in the studio).

The range of pitches the detector listens to; everything outside is ignored.
Choose the range where your sound is clearly louder than the background:

- Look at the spectrogram: the sound's bright horizontal lines (tones) should
  sit inside the band; areas full of background noise (low rumble, extractor
  hood hiss) should preferably be outside.
- “Suggest from examples” in step 3 picks the range where your examples stand
  out most from the background of the same recording.
- Narrower is usually more robust (less background gets in), but keep all the
  main tones of the sound inside. Default 400–4500 Hz suits most buzzers and
  chimes. The detector cannot hear above 8 kHz.

## Sound length

Template duration (`frames` in the preset; 62.5 frames per second).

How long a stretch of audio is compared with the template at a time — typically
one beep, or one phrase of a chime or melody (TM6: 1.3 s). It should cover the
characteristic part of the sound with little silence around it:

- Too short: different sounds start to look alike (fewer details to compare).
- Too long: the window contains mostly background or the gaps between
  repetitions, which dilutes the match, and the template needs more memory
  (about 1 KB per 0.1 s at the default band).
- For a repeating alarm use one repetition, not the whole sequence — e.g. one
  beep of a 5-beep alarm (see [what to mark as one example](preset_authoring.md#what-to-mark-as-one-example)).

## Repeating or single

Whether the appliance repeats the same sound at a steady rhythm until someone
reacts (`period_s` set) or plays it once (`period_s: null`).

Repeating alarms are the most reliable to detect: the detector also checks the
rhythm, which random kitchen noise practically never reproduces. For a single
melody or beep, use single mode with *minimum repetitions* 1.

## Threshold

`threshold`, default 0.55.

Match score needed to count a repetition. Raising it reduces false alarms but
may miss quieter or partly masked alarms; lowering it does the opposite.

Use **Suggest thresholds** in step 3: it scores your accepted examples and
everything else in your recordings and places the threshold halfway between the
weakest example and the loudest non-example. The difference between the two is
the **margin**; aim for at least +0.10, ideally more than +0.2. A small margin
means the preset is fragile: add better examples, record confusing sounds,
narrow the band or adjust the sound length.

## Near threshold

`near_threshold`, default 0.35. Must be lower than the threshold.

Peaks between this level and the threshold are reported as **near misses**
(logged on the device, published to the match-score sensor, available as an
`on_near_miss` trigger). They do not trigger anything; they help you see which
sounds come close to triggering before they become false alarms.

## Minimum repetitions

`min_repetitions`, default 2 for repeating alarms, 1 for single sounds.

How many repetitions are needed before the alarm turns on. With 2, a repeating
alarm is reported after its second repetition (TM6: about 6–8 s), and a single
stray match can never trigger it. With 1, the alarm reacts to the first match —
faster, but every false match becomes a false alarm.

## Period

`period_s`, seconds; empty/`null` for single sounds.

Time from the start of one repetition to the start of the next (TM6: 3.125 s).
“Estimate repetition” in step 3 reads it from the spacing of your examples in one
recording. For repeating alarms, repetitions only chain into an alarm when they
arrive about one (or, if one was missed, two) periods apart.

## Period tolerance

`period_tolerance_s`, default 0.25 s.

How far the spacing between repetitions may differ from the period and still
count. Appliance alarms are usually very regular, so a small tolerance works;
increase it if the device misses alarms although every repetition is detected.

## Refractory

`refractory_s`, default 1.5 s.

After a repetition is counted, new matches are ignored for this long so that one
sound (whose score can peak several times) is not counted twice. Keep it longer
than the sound itself but shorter than the period — for fast beeps (e.g. one per
second) the default is too long and would skip every other beep. “Estimate
repetition” sets it to 0.6 × period (at most 1.5 s).

## Release

`release_s`, default 2 × period + 1 s (TM6: 7.25 s); for single sounds a few
seconds.

How long the alarm stays on after the last repetition. For repeating alarms this
must be longer than the period (otherwise the alarm would flicker off between
repetitions); 2 × period + 1 s also tolerates one missed repetition.

## Accepting candidates

In step 2, “Find similar” lists places that resemble your seed example. Each
candidate box is exactly one *sound length* long, positioned where the match is
best:

- **Accept** if the whole characteristic sound is inside the box. Some quiet
  before or after it is normal and fine.
- **Reject** if it is a different sound, or only a fragment of yours (e.g. the
  box catches the end of one repetition and the start of the next).
- If your sound fills only a small part of every box, the sound length is too
  long — reduce it in step 3 and run “Find similar” again.
- Decisions can be changed at any time (“Undo”, “Accept instead”,
  “Reject instead”).

Examples you mark by hand do not need to be exactly the right length either: the
builder takes one sound-length window centred on your selection (and fine-tunes
its position by up to ±0.13 s), so centre the selection on the sound.
