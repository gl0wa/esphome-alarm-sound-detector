import gzip
import re
from pathlib import Path

import esphome.codegen as cg
from esphome.components import microphone
from esphome.components.esp32 import include_builtin_idf_component
import esphome.config_validation as cv
from esphome.const import CONF_ID, CONF_MICROPHONE, CONF_PORT
from esphome.core import ID
import esphome.final_validate as fv
from esphome.types import ConfigType

CODEOWNERS = ["@thermomix-alert-detector"]
DEPENDENCIES = ["esp32", "microphone", "network"]
AUTO_LOAD = ["ring_buffer"]

CONF_KEY = "key"
CONF_MAX_DURATION = "max_duration"
CONF_STUDIO_URL = "studio_url"

DOMAIN = "capture_server"

capture_server_ns = cg.esphome_ns.namespace("capture_server")
CaptureServer = capture_server_ns.class_("CaptureServer", cg.Component)

DEFAULT_STUDIO_URL = "https://gl0wa.github.io/esphome-alarm-sound-detector/"

_KEY_RE = re.compile(r"[A-Za-z0-9_-]*\Z")


def validate_key(value: str) -> str:
    value = cv.string_strict(value)
    if len(value) < 16:
        raise cv.Invalid("capture_server key must be at least 16 characters long")
    if _KEY_RE.fullmatch(value) is None:
        raise cv.Invalid(
            "capture_server key may only contain letters, digits, '-' and '_'"
        )
    return value


CONFIG_SCHEMA = cv.Schema(
    {
        cv.GenerateID(): cv.declare_id(CaptureServer),
        cv.Optional(CONF_MICROPHONE, default={}): microphone.microphone_source_schema(
            min_bits_per_sample=16,
            max_bits_per_sample=16,
            max_channels=1,
        ),
        cv.Required(CONF_KEY): validate_key,
        cv.Optional(CONF_PORT, default=80): cv.port,
        cv.Optional(CONF_MAX_DURATION, default="30min"): cv.positive_time_period,
        cv.Optional(CONF_STUDIO_URL, default=DEFAULT_STUDIO_URL): cv.url,
    }
).extend(cv.COMPONENT_SCHEMA)


def check_port_conflict(config: ConfigType) -> ConfigType:
    """Reject a port clash with the ESPHome web server (same port)."""
    full_config = fv.full_config.get()
    web_server = full_config.get("web_server")
    if web_server:
        entries = web_server if isinstance(web_server, list) else [web_server]
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            if entry.get(CONF_PORT, 80) == config[CONF_PORT]:
                raise cv.Invalid(
                    f"capture_server port ({config[CONF_PORT]}) clashes with the "
                    f"ESPHome web_server on the same port; pick another port for "
                    f"one of them"
                )
    return config


FINAL_VALIDATE_SCHEMA = cv.All(
    cv.Schema(
        {
            cv.Required(
                CONF_MICROPHONE
            ): microphone.final_validate_microphone_source_schema(
                "capture_server", sample_rate=16000
            ),
        },
        extra=cv.ALLOW_EXTRA,
    ),
    check_port_conflict,
)


async def to_code(config: ConfigType) -> None:
    var = cg.new_Pvariable(config[CONF_ID])
    await cg.register_component(var, config)

    mic_source = await microphone.microphone_source_to_code(
        config[CONF_MICROPHONE], passive=False
    )
    cg.add(var.set_microphone_source(mic_source))
    # The key is only ever compared on-device; it never appears in logs.
    cg.add(var.set_auth_key(config[CONF_KEY]))
    cg.add(var.set_port(config[CONF_PORT]))
    cg.add(
        var.set_max_duration_s(int(config[CONF_MAX_DURATION].total_seconds))
    )
    cg.add(var.set_studio_url(config[CONF_STUDIO_URL]))

    # Gzip the capture page at codegen and embed it as a flash array.
    page = (Path(__file__).parent / "page.html").read_bytes()
    gzipped = gzip.compress(page, compresslevel=9)
    arr_id = ID(
        f"{config[CONF_ID]}_page_gzip", is_declaration=True, type=cg.uint8
    )
    arr = cg.static_const_array(arr_id, cg.ArrayInitializer(*gzipped))
    cg.add(var.set_page_gzip(arr, len(gzipped), len(page)))

    # A dedicated esp_http_server instance (independent of web_server).
    include_builtin_idf_component("esp_http_server")
