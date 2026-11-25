import base64
import json
from pathlib import Path

import esphome.codegen as cg
from esphome.components import microphone
import esphome.config_validation as cv
from esphome import automation
from esphome.const import CONF_ID, CONF_MICROPHONE, CONF_THRESHOLD
from esphome.core import CORE, ID
from esphome.types import ConfigType

CODEOWNERS = ["@thermomix-alert-detector"]
DEPENDENCIES = ["esp32", "microphone"]
AUTO_LOAD = ["audio", "ring_buffer"]

# The portable core lives in the same directory and is compiled for the
# target by ESPHome; it includes no ESPHome headers (see detector_core.h).
alarm_sound_detector_ns = cg.esphome_ns.namespace("alarm_sound_detector")
AlarmSoundDetector = alarm_sound_detector_ns.class_("AlarmSoundDetector", cg.Component)

CONF_TEMPLATE = "template"
CONF_NEAR_THRESHOLD = "near_threshold"
CONF_PERIOD = "period"
CONF_PERIOD_TOLERANCE = "period_tolerance"
CONF_MIN_REPETITIONS = "min_repetitions"
CONF_ON_ALARM_START = "on_alarm_start"
CONF_ON_ALARM_END = "on_alarm_end"
CONF_ON_REPETITION = "on_repetition"
CONF_ON_NEAR_MISS = "on_near_miss"

TEMPLATES_DIR = Path(__file__).parent / "templates"

# Must match detector_core.h / tools/detector/ref.py.
CORE_SR = 16000
CORE_N_FFT = 512
CORE_HOP = 256
CORE_BIN_LO = 13
CORE_BIN_HI = 144


def _load_template(value: str) -> dict:
    """Resolve a template reference to its JSON doc.

    A bare name (e.g. ``thermomix_tm6``) selects a builtin from this
    component's ``templates/`` directory; anything else is treated as a path
    to a JSON file relative to the main YAML file (as produced by
    ``tools/detector/make_template.py``).
    """
    p = Path(value)
    if len(p.parts) == 1 and p.suffix == "":
        candidate = TEMPLATES_DIR / f"{value}.json"
        if candidate.is_file():
            return json.loads(candidate.read_text())
        raise cv.Invalid(f"Unknown builtin template {value!r}")
    base = CORE.config_dir if CORE.config_dir else Path.cwd()
    candidate = (base / p).resolve()
    if not candidate.is_file():
        raise cv.Invalid(f"Template file not found: {candidate}")
    try:
        return json.loads(candidate.read_text())
    except (OSError, ValueError) as err:
        raise cv.Invalid(f"Cannot read template {candidate}: {err}")


def _validate_template(doc: dict) -> dict:
    for key in ("format", "sample_rate", "n_fft", "hop", "bin_lo", "bin_hi",
                "frames", "bins", "period_s", "data_int8_b64"):
        if key not in doc:
            raise cv.Invalid(f"Template is missing key {key!r}")
    checks = [
        (doc["format"] == 1, "unsupported format (expected 1)"),
        (doc["sample_rate"] == CORE_SR, f"sample_rate must be {CORE_SR}"),
        (doc["n_fft"] == CORE_N_FFT, f"n_fft must be {CORE_N_FFT}"),
        (doc["hop"] == CORE_HOP, f"hop must be {CORE_HOP}"),
        (doc["bin_lo"] == CORE_BIN_LO, f"bin_lo must be {CORE_BIN_LO}"),
        (doc["bin_hi"] == CORE_BIN_HI, f"bin_hi must be {CORE_BIN_HI}"),
        (doc["frames"] > 0 and doc["bins"] == CORE_BIN_HI - CORE_BIN_LO + 1,
         "frames/bins mismatch the core geometry"),
        (doc["period_s"] > 0, "period_s must be positive"),
    ]
    for ok, msg in checks:
        if not ok:
            raise cv.Invalid(f"Invalid template: {msg}")
    try:
        raw = base64.b64decode(doc["data_int8_b64"])
    except (ValueError, TypeError) as err:
        raise cv.Invalid(f"Invalid template data_int8_b64: {err}")
    if len(raw) != doc["frames"] * doc["bins"]:
        raise cv.Invalid(
            f"Invalid template: data has {len(raw)} bytes, "
            f"expected {doc['frames'] * doc['bins']}")
    doc["data_int8"] = [b if b < 128 else b - 256 for b in raw]
    return doc


def validate_detector_config(config: ConfigType) -> ConfigType:
    doc = _validate_template(_load_template(config[CONF_TEMPLATE]))
    config["_template_doc"] = doc
    if config.get(CONF_PERIOD) is not None and config[CONF_PERIOD].total_milliseconds <= 0:
        raise cv.Invalid("period must be positive")
    if not config[CONF_THRESHOLD] > config[CONF_NEAR_THRESHOLD]:
        raise cv.Invalid("threshold must be greater than near_threshold")
    return config


CONFIG_SCHEMA = cv.All(
    cv.Schema(
        {
            cv.GenerateID(): cv.declare_id(AlarmSoundDetector),
            cv.Optional(CONF_MICROPHONE, default={}): microphone.microphone_source_schema(
                min_bits_per_sample=16,
                max_bits_per_sample=32,
                max_channels=1,
            ),
            cv.Required(CONF_TEMPLATE): cv.string,
            cv.Optional(CONF_THRESHOLD, default=0.55): cv.zero_to_one_float,
            cv.Optional(CONF_NEAR_THRESHOLD, default=0.35): cv.zero_to_one_float,
            cv.Optional(CONF_PERIOD): cv.positive_time_period,
            cv.Optional(CONF_PERIOD_TOLERANCE, default="250ms"): cv.positive_time_period,
            cv.Optional(CONF_MIN_REPETITIONS, default=2): cv.int_range(min=1, max=255),
            cv.Optional(CONF_ON_ALARM_START): automation.validate_automation(single=True),
            cv.Optional(CONF_ON_ALARM_END): automation.validate_automation(single=True),
            cv.Optional(CONF_ON_REPETITION): automation.validate_automation(
                cv.Schema({cv.GenerateID(CONF_ID): cv.use_id(AlarmSoundDetector)})),
            cv.Optional(CONF_ON_NEAR_MISS): automation.validate_automation(
                cv.Schema({cv.GenerateID(CONF_ID): cv.use_id(AlarmSoundDetector)})),
        }
    ).extend(cv.COMPONENT_SCHEMA),
    validate_detector_config,
)

FINAL_VALIDATE_SCHEMA = cv.Schema(
    {
        cv.Required(CONF_MICROPHONE): microphone.final_validate_microphone_source_schema(
            "alarm_sound_detector"
        ),
    },
    extra=cv.ALLOW_EXTRA,
)


async def to_code(config: ConfigType) -> None:
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)

    mic_source = await microphone.microphone_source_to_code(
        config[CONF_MICROPHONE], passive=False
    )
    cg.add(var.set_microphone_source(mic_source))

    doc = config["_template_doc"]
    # Emit the quantised template as a const array in flash.
    arr_id = ID(f"{config[CONF_ID]}_template_data", is_declaration=True, type=cg.int8)
    arr = cg.static_const_array(arr_id, cg.ArrayInitializer(*doc["data_int8"]))
    period_s = (config[CONF_PERIOD].total_milliseconds / 1000 if config.get(CONF_PERIOD) is not None
                else float(doc["period_s"]))
    cg.add(var.set_template(arr, doc["frames"], doc["bins"], str(config[CONF_TEMPLATE]),
                            period_s))
    cg.add(var.set_threshold(config[CONF_THRESHOLD]))
    cg.add(var.set_near_threshold(config[CONF_NEAR_THRESHOLD]))
    cg.add(var.set_period_tolerance(config[CONF_PERIOD_TOLERANCE].total_milliseconds / 1000))
    cg.add(var.set_min_repetitions(config[CONF_MIN_REPETITIONS]))

    for key, trigger, args in (
        (CONF_ON_ALARM_START, var.get_alarm_start_trigger(), []),
        (CONF_ON_ALARM_END, var.get_alarm_end_trigger(), []),
    ):
        if key in config:
            await automation.build_automation(trigger, args, config[key])
    for conf in config.get(CONF_ON_REPETITION, []):
        await automation.build_automation(
            var.get_repetition_trigger(), [(cg.float_, "score")], conf)
    for conf in config.get(CONF_ON_NEAR_MISS, []):
        await automation.build_automation(
            var.get_near_miss_trigger(), [(cg.float_, "score")], conf)
