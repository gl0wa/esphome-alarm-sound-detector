import esphome.codegen as cg
from esphome.components import microphone
import esphome.config_validation as cv
from esphome import automation
from esphome.const import CONF_ID, CONF_MICROPHONE, CONF_THRESHOLD
from esphome.core import CORE, ID
from esphome.types import ConfigType

from . import preset_util

CODEOWNERS = ["@thermomix-alert-detector"]
DEPENDENCIES = ["esp32", "microphone"]
AUTO_LOAD = ["audio", "ring_buffer"]
MULTI_CONF = True

# The portable core lives in the same directory and is compiled for the
# target by ESPHome; it includes no ESPHome headers (see detector_core.h).
alarm_sound_detector_ns = cg.esphome_ns.namespace("alarm_sound_detector")
AlarmSoundDetector = alarm_sound_detector_ns.class_("AlarmSoundDetector", cg.Component)

CONF_TEMPLATE = "template"
CONF_NEAR_THRESHOLD = "near_threshold"
CONF_PERIOD = "period"
CONF_PERIOD_TOLERANCE = "period_tolerance"
CONF_MIN_REPETITIONS = "min_repetitions"
CONF_REFRACTORY = "refractory"
CONF_RELEASE = "release"
CONF_ON_ALARM_START = "on_alarm_start"
CONF_ON_ALARM_END = "on_alarm_end"
CONF_ON_REPETITION = "on_repetition"
CONF_ON_NEAR_MISS = "on_near_miss"

# Must match detector_core.h / tools/detector/ref.py.
CORE_SR = preset_util.CORE_SR
CORE_N_FFT = preset_util.CORE_N_FFT
CORE_HOP = preset_util.CORE_HOP


def validate_detector_config(config: ConfigType) -> ConfigType:
    try:
        preset = preset_util.resolve_template(
            config[CONF_TEMPLATE],
            CORE.config_dir if CORE.config_dir else ".")
    except preset_util.PresetError as err:
        raise cv.Invalid(str(err))

    thr = config.get(CONF_THRESHOLD, preset["threshold"])
    near = config.get(CONF_NEAR_THRESHOLD, preset["near_threshold"])
    if not thr > near:
        raise cv.Invalid(
            f"threshold ({thr}) must be greater than near_threshold ({near})")
    min_rep = config.get(CONF_MIN_REPETITIONS, preset["min_repetitions"])

    def seconds(key: str, default: float | None) -> float | None:
        tp = config.get(key)
        return tp.total_milliseconds / 1000 if tp is not None else default

    period = seconds(CONF_PERIOD, preset["period_s"])
    if period is not None and period <= 0:
        raise cv.Invalid("period must be positive (omit it for single-sound presets)")
    tol = seconds(CONF_PERIOD_TOLERANCE, preset["period_tolerance_s"])
    if tol is not None and tol < 0:
        raise cv.Invalid("period_tolerance must not be negative")
    refractory = seconds(CONF_REFRACTORY, preset["refractory_s"])
    if refractory is None or refractory < 0:
        raise cv.Invalid("refractory must not be negative")
    release = seconds(CONF_RELEASE, preset["release_s"])
    if release is None or release <= 0:
        raise cv.Invalid("release must be positive")

    # Merged detection parameters: every YAML field is optional and
    # overrides the preset default.
    config["_preset"] = preset
    config["_detection"] = {
        "threshold": thr,
        "near_threshold": near,
        "min_repetitions": min_rep,
        "period_s": period,
        "period_tolerance_s": tol if tol is not None else 0.0,
        "refractory_s": refractory,
        "release_s": release,
    }
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
            # All detection fields are optional: omitted fields default to
            # the selected preset's tuned values (see presets/*.json).
            cv.Optional(CONF_THRESHOLD): cv.zero_to_one_float,
            cv.Optional(CONF_NEAR_THRESHOLD): cv.zero_to_one_float,
            cv.Optional(CONF_PERIOD): cv.positive_time_period,
            cv.Optional(CONF_PERIOD_TOLERANCE): cv.positive_time_period,
            cv.Optional(CONF_MIN_REPETITIONS): cv.int_range(min=1, max=255),
            cv.Optional(CONF_REFRACTORY): cv.positive_time_period,
            cv.Optional(CONF_RELEASE): cv.positive_time_period,
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

    preset = config["_preset"]
    det = config["_detection"]
    # Emit the quantised template as a const array in flash. One array per
    # detector instance: only the selected presets are compiled in.
    arr_id = ID(f"{config[CONF_ID]}_template_data", is_declaration=True, type=cg.int8)
    arr = cg.static_const_array(arr_id, cg.ArrayInitializer(*preset["data_int8"]))
    # period_s <= 0 selects the single (no-periodicity) mode in the core.
    period_s = det["period_s"] if det["period_s"] is not None else -1.0
    cg.add(var.set_template(arr, preset["frames"], preset["bins"],
                            preset["bin_lo"], preset["bin_hi"],
                            str(config[CONF_TEMPLATE]), period_s,
                            det["refractory_s"], det["release_s"]))
    cg.add(var.set_threshold(det["threshold"]))
    cg.add(var.set_near_threshold(det["near_threshold"]))
    cg.add(var.set_period_tolerance(det["period_tolerance_s"]))
    cg.add(var.set_min_repetitions(det["min_repetitions"]))

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
