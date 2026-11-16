"""Shared helpers: config loading and Owlet login."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import aiohttp
from pyowletapi.api import OwletAPI
from pyowletapi.sock import Sock

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.json"


def load_config() -> dict:
    """Read config.json (logins + time zone). It's git-ignored: never commit it."""
    if not CONFIG_PATH.exists():
        sys.exit(
            f"Missing {CONFIG_PATH.name}. Copy config.example.json to config.json and fill it in."
        )
    with CONFIG_PATH.open(encoding="utf-8") as f:
        return json.load(f)


async def pick_child(hb, name: str | None) -> str:
    """Huckleberry child id: the one named `name`, else the first child."""
    children = (await hb.get_user()).childList
    if name:
        for c in children:
            if (c.nickname or "").lower() == name.lower():
                return c.cid
        raise SystemExit(f"No Huckleberry child named {name!r}; found {[c.nickname for c in children]}")
    if len(children) > 1:
        print("Several children in Huckleberry; using the first. Set huckleberry.child_name in config.json.")
    return children[0].cid


async def owlet_login(cfg: dict, session: aiohttp.ClientSession) -> tuple[OwletAPI, list[Sock]]:
    """Sign in to Owlet with pyowletapi and return the API client plus the account's socks.

    pyowletapi does the 3-step login (Google sign-in -> Owlet mini token -> Ayla access
    token). From Python there are no browser CORS rules, so no relay is needed here.
    """
    o = cfg["owlet"]
    api = OwletAPI(o.get("region", "world"), o["email"], o["password"], session=session)
    await api.authenticate()
    devices = await api.get_devices()
    socks = [Sock(api, d["device"]) for d in devices["response"]]
    return api, socks
