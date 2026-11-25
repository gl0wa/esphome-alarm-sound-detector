import esphome.codegen as cg
from esphome.components import sensor
import esphome.config_validation as cv
from esphome.const import STATE_CLASS_MEASUREMENT
from esphome.types import ConfigType

from .. import alarm_sound_detector_ns

DEPENDENCIES = ["alarm_sound_detector"]

AlarmSoundDetector = alarm_sound_detector_ns.class_("AlarmSoundDetector")
MatchScoreSensor = alarm_sound_detector_ns.class_(
    "MatchScoreSensor", sensor.Sensor, cg.Component
)

CONF_ALARM_SOUND_DETECTOR_ID = "alarm_sound_detector_id"
CONF_REPORT_INTERVAL = "report_interval"

CONFIG_SCHEMA = (
    sensor.sensor_schema(
        MatchScoreSensor,
        accuracy_decimals=3,
        state_class=STATE_CLASS_MEASUREMENT,
    )
    .extend(
        {
            cv.GenerateID(CONF_ALARM_SOUND_DETECTOR_ID): cv.use_id(AlarmSoundDetector),
            cv.Optional(CONF_REPORT_INTERVAL, default="60s"): cv.positive_time_period,
        }
    )
    .extend(cv.COMPONENT_SCHEMA)
)


async def to_code(config: ConfigType) -> None:
    var = await sensor.new_sensor(config)
    await cg.register_component(var, config)
    parent = await cg.get_variable(config[CONF_ALARM_SOUND_DETECTOR_ID])
    cg.add(var.set_parent(parent))
    cg.add(var.set_report_interval_ms(config[CONF_REPORT_INTERVAL].total_milliseconds))
