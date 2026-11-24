import esphome.codegen as cg
from esphome.components import switch
import esphome.config_validation as cv
from esphome.types import ConfigType

from .. import audio_capture_ns

DEPENDENCIES = ["audio_capture"]

CaptureSwitch = audio_capture_ns.class_(
    "CaptureSwitch", switch.Switch, cg.Component
)

CONF_AUDIO_CAPTURE_ID = "audio_capture_id"

CONFIG_SCHEMA = (
    switch.switch_schema(CaptureSwitch, default_restore_mode="RESTORE_DEFAULT_OFF")
    .extend(
        {
            cv.GenerateID(CONF_AUDIO_CAPTURE_ID): cv.use_id(
                audio_capture_ns.class_("AudioCaptureComponent")
            ),
        }
    )
    .extend(cv.COMPONENT_SCHEMA)
)


async def to_code(config: ConfigType) -> None:
    var = await switch.new_switch(config)
    await cg.register_component(var, config)

    parent = await cg.get_variable(config[CONF_AUDIO_CAPTURE_ID])
    cg.add(var.set_parent(parent))
