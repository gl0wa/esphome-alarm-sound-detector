import esphome.codegen as cg
from esphome.components import binary_sensor
import esphome.config_validation as cv
from esphome.const import DEVICE_CLASS_CONNECTIVITY
from esphome.types import ConfigType

from .. import audio_capture_ns

DEPENDENCIES = ["audio_capture"]

AudioCaptureComponent = audio_capture_ns.class_("AudioCaptureComponent")

CONF_AUDIO_CAPTURE_ID = "audio_capture_id"

CONFIG_SCHEMA = (
    binary_sensor.binary_sensor_schema(device_class=DEVICE_CLASS_CONNECTIVITY)
    .extend(
        {
            cv.GenerateID(CONF_AUDIO_CAPTURE_ID): cv.use_id(AudioCaptureComponent),
        }
    )
    .extend(cv.COMPONENT_SCHEMA)
)


async def to_code(config: ConfigType) -> None:
    var = await binary_sensor.new_binary_sensor(config)
    parent = await cg.get_variable(config[CONF_AUDIO_CAPTURE_ID])
    cg.add(parent.set_client_connected_binary_sensor(var))
