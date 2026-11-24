import esphome.codegen as cg
from esphome.components import sensor
import esphome.config_validation as cv
from esphome.const import (
    DEVICE_CLASS_DATA_SIZE,
    STATE_CLASS_TOTAL_INCREASING,
    UNIT_BYTES,
)
from esphome.types import ConfigType

from .. import audio_capture_ns

DEPENDENCIES = ["audio_capture"]

AudioCaptureComponent = audio_capture_ns.class_("AudioCaptureComponent")

CONF_AUDIO_CAPTURE_ID = "audio_capture_id"

CONFIG_SCHEMA = (
    sensor.sensor_schema(
        unit_of_measurement=UNIT_BYTES,
        accuracy_decimals=0,
        device_class=DEVICE_CLASS_DATA_SIZE,
        state_class=STATE_CLASS_TOTAL_INCREASING,
    )
    .extend(
        {
            cv.GenerateID(CONF_AUDIO_CAPTURE_ID): cv.use_id(AudioCaptureComponent),
        }
    )
    .extend(cv.COMPONENT_SCHEMA)
)


async def to_code(config: ConfigType) -> None:
    var = await sensor.new_sensor(config)
    parent = await cg.get_variable(config[CONF_AUDIO_CAPTURE_ID])
    cg.add(parent.set_dropped_bytes_sensor(var))
