"""
Codificacion ciclica de la hora local. ESPEJO EXACTO de src/common/local-time.ts.

    local_minutes = local_hour * 60 + local_minute
    angle         = 2 * pi * local_minutes / 1440
    local_time_sin = sin(angle)
    local_time_cos = cos(angle)

Se usa `zoneinfo` (estandar de Python) con nombres IANA, no offsets fijos,
porque el offset no captura el horario de verano.
"""

import math
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

MINUTES_PER_DAY = 1440

# Mismo mapa que src/common/route-timezone.ts.
DEMO_COUNTRY_TIME_ZONES = {
    "CO": "America/Bogota",
    "MX": "America/Mexico_City",
    "BR": "America/Sao_Paulo",
    "AR": "America/Argentina/Buenos_Aires",
    "CL": "America/Santiago",
    "PE": "America/Lima",
    "US": "America/New_York",
    "ES": "Europe/Madrid",
}


def local_hour_minute(at: datetime, tz_name: str):
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    try:
        local = at.astimezone(ZoneInfo(tz_name))
    except Exception:
        local = at.astimezone(timezone.utc)
    return local.hour, local.minute


def encode_local_time(at: datetime, tz_name: str):
    hour, minute = local_hour_minute(at, tz_name)
    local_minutes = hour * 60 + minute
    angle = 2 * math.pi * local_minutes / MINUTES_PER_DAY
    return {
        "local_hour": hour,
        "local_minute": minute,
        "local_minutes": local_minutes,
        "local_time_sin": math.sin(angle),
        "local_time_cos": math.cos(angle),
    }


def daypart_of(local_hour: int) -> str:
    if local_hour < 6:
        return "NIGHT"
    if local_hour < 12:
        return "MORNING"
    if local_hour < 18:
        return "AFTERNOON"
    return "EVENING"
