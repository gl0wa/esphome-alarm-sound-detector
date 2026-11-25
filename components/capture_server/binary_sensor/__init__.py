import esphome.codegen as cg
from esphome.components import binary_sensor
import esphome.config_validation as cv
from esphome.const import DEVICE_CLASS_CONNECTIVITY
from esphome.types import ConfigType

from .. import capture_server_ns

DEPENDENCIES = ["capture_server"]

CaptureServer = capture_server_ns.class_("CaptureServer")

CONF_CAPTURE_SERVER_ID = "capture_server_id"

CONFIG_SCHEMA = (
    binary_sensor.binary_sensor_schema(device_class=DEVICE_CLASS_CONNECTIVITY)
    .extend(
        {
            cv.GenerateID(CONF_CAPTURE_SERVER_ID): cv.use_id(CaptureServer),
        }
    )
    .extend(cv.COMPONENT_SCHEMA)
)


async def to_code(config: ConfigType) -> None:
    var = await binary_sensor.new_binary_sensor(config)
    parent = await cg.get_variable(config[CONF_CAPTURE_SERVER_ID])
    cg.add(parent.set_recording_binary_sensor(var))
