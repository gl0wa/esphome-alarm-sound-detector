import esphome.codegen as cg
from esphome.components import binary_sensor
import esphome.config_validation as cv
from esphome.types import ConfigType

from .. import alarm_sound_detector_ns

DEPENDENCIES = ["alarm_sound_detector"]

AlarmSoundDetector = alarm_sound_detector_ns.class_("AlarmSoundDetector")
AlarmBinarySensor = alarm_sound_detector_ns.class_(
    "AlarmBinarySensor", binary_sensor.BinarySensor, cg.Component
)

CONF_ALARM_SOUND_DETECTOR_ID = "alarm_sound_detector_id"

CONFIG_SCHEMA = (
    binary_sensor.binary_sensor_schema(AlarmBinarySensor)
    .extend(
        {
            cv.GenerateID(CONF_ALARM_SOUND_DETECTOR_ID): cv.use_id(AlarmSoundDetector),
        }
    )
    .extend(cv.COMPONENT_SCHEMA)
)


async def to_code(config: ConfigType) -> None:
    var = await binary_sensor.new_binary_sensor(config)
    await cg.register_component(var, config)
    parent = await cg.get_variable(config[CONF_ALARM_SOUND_DETECTOR_ID])
    cg.add(var.set_parent(parent))
