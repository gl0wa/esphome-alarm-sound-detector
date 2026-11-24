import esphome.codegen as cg
from esphome.components import microphone, socket
import esphome.config_validation as cv
from esphome import automation
from esphome.const import (
    CONF_BITS_PER_SAMPLE,
    CONF_CHANNELS,
    CONF_GAIN_FACTOR,
    CONF_ID,
    CONF_MICROPHONE,
    CONF_PORT,
    CONF_TYPE,
)
from esphome.types import ConfigType

CODEOWNERS = ["@thermomix-alert-detector"]
DEPENDENCIES = ["esp32", "microphone", "socket"]
AUTO_LOAD = ["audio", "socket", "ring_buffer", "hmac_sha256"]

audio_capture_ns = cg.esphome_ns.namespace("audio_capture")
AudioCaptureComponent = audio_capture_ns.class_("AudioCaptureComponent", cg.Component)
MarkAction = audio_capture_ns.class_("MarkAction", automation.Action)

CONF_LABEL = "label"
CONF_PSK = "psk"

CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(AudioCaptureComponent),
        cv.Optional(CONF_MICROPHONE, default={}): microphone.microphone_source_schema(
            min_bits_per_sample=16,
            max_bits_per_sample=32,
            max_channels=1,
        ),
        cv.Optional(CONF_PORT, default=6060): cv.port,
        cv.Optional("buffer_size", default=65536): cv.int_range(min=16384, max=262144),
        cv.Required(CONF_PSK): cv.All(cv.string, cv.Length(min=16)),
    }
).extend(cv.COMPONENT_SCHEMA)

FINAL_VALIDATE_SCHEMA = cv.Schema(
    {
        cv.Required(CONF_MICROPHONE): microphone.final_validate_microphone_source_schema(
            "audio_capture"
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
    cg.add(var.set_port(config[CONF_PORT]))
    cg.add(var.set_buffer_size(config["buffer_size"]))
    cg.add(var.set_psk(config[CONF_PSK]))

    socket.consume_sockets(1, "audio_capture")(config)
    socket.consume_sockets(1, "audio_capture", socket.SocketType.TCP_LISTEN)(config)


AUDIO_CAPTURE_MARK_SCHEMA = automation.maybe_simple_id(
    {
        cv.GenerateID(): cv.use_id(AudioCaptureComponent),
        cv.Required(CONF_LABEL): cv.string,
    }
)


@automation.register_action(
    "audio_capture.mark", MarkAction, AUDIO_CAPTURE_MARK_SCHEMA, synchronous=True
)
async def audio_capture_mark_to_code(config, action_id, template_arg, args):
    paren = await cg.get_variable(config[CONF_ID])
    var = cg.new_Pvariable(action_id, template_arg, paren)
    cg.add(var.set_label(config[CONF_LABEL]))
    return var
