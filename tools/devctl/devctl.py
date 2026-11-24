"""Tiny dev helper: drive ESPHome entities over the encrypted native API.

Usage:
  devctl.py --host H list
  devctl.py --host H switch "Audio capture" on|off
  devctl.py --host H press "Mark: Thermomix alarm"
The API key is read from firmware/secrets.yaml (api_encryption_key).
"""
from __future__ import annotations

import argparse
import asyncio
import re
from pathlib import Path

from aioesphomeapi import APIClient, ButtonInfo, SwitchInfo


def read_secret(path: Path, key: str) -> str:
    for line in path.read_text().splitlines():
        m = re.match(rf"^\s*{re.escape(key)}\s*:\s*['\"]?([^'\"#]+?)['\"]?\s*$", line)
        if m:
            return m.group(1)
    raise SystemExit(f"{key} not found in {path}")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", required=True)
    ap.add_argument("--secrets", default="firmware/secrets.yaml")
    ap.add_argument("cmd", choices=["list", "switch", "press"])
    ap.add_argument("name", nargs="?")
    ap.add_argument("state", nargs="?", choices=["on", "off"])
    a = ap.parse_args()

    cli = APIClient(a.host, 6053, None, noise_psk=read_secret(Path(a.secrets), "api_encryption_key"))
    await cli.connect(login=True)
    try:
        entities, _ = await cli.list_entities_services()
        if a.cmd == "list":
            for e in entities:
                print(f"{type(e).__name__:28s} {e.name}")
            return
        match = [e for e in entities if e.name == a.name]
        if not match:
            raise SystemExit(f"entity {a.name!r} not found")
        e = match[0]
        if a.cmd == "switch" and isinstance(e, SwitchInfo):
            cli.switch_command(e.key, a.state == "on")
        elif a.cmd == "press" and isinstance(e, ButtonInfo):
            cli.button_command(e.key)
        else:
            raise SystemExit("entity type does not match command")
        await asyncio.sleep(0.5)
        print("ok")
    finally:
        await cli.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
