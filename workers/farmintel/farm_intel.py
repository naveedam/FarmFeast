"""
FarmFeast · Farm Intelligence worker (weather alerts, crop calendar, soil analytics)
-------------------------------------------------------------------------------
For every active farm:
  1. Weather   — Open-Meteo: past 7 + next 7 days → ff_weather_daily
  2. Soil      — ISRIC SoilGrids v2 (once per farm) → ff_soil_profiles
  3. Advisories— agro.py rules for weather, crop calendar, soil/fertiliser → ff_advisories
  4. Optional  — WhatsApp push of new warn/alert advisories via Twilio (SEND_ALERTS=true)

Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (required)
     SEND_ALERTS=true + TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM (optional)
     ONLY_TEST_FARMS=true  → process only ff_farms.source='test' (validation runs)
"""
from __future__ import annotations

import logging
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone

import requests

import agro

log = logging.getLogger("farmintel")
IST = timezone(timedelta(hours=5, minutes=30))
HTTP = requests.Session()
HTTP.headers["User-Agent"] = "FarmFeast-farmintel/1.0"

WEATHER_VARS = ["temperature_2m_max", "temperature_2m_min", "precipitation_sum",
                "precipitation_probability_max", "et0_fao_evapotranspiration",
                "wind_speed_10m_max", "relative_humidity_2m_mean"]
WEATHER_COLS = ["tmax_c", "tmin_c", "rain_mm", "rain_prob_pct", "et0_mm", "wind_max_kmh", "humidity_pct"]


def today_ist() -> date:
    return datetime.now(IST).date()


# ── Supabase REST ─────────────────────────────────────────────────────
class Supa:
    def __init__(self):
        self.url = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1"
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        self.h = {"apikey": key, "Authorization": f"Bearer {key}"}

    def get(self, table: str, **params) -> list[dict]:
        r = HTTP.get(f"{self.url}/{table}", params={"select": "*", **params}, headers=self.h, timeout=60)
        r.raise_for_status()
        return r.json()

    def upsert(self, table: str, rows: list[dict] | dict, on_conflict: str):
        if not rows:
            return
        r = HTTP.post(f"{self.url}/{table}", params={"on_conflict": on_conflict}, json=rows, timeout=60,
                      headers={**self.h, "Prefer": "resolution=merge-duplicates,return=minimal"})
        if r.status_code >= 300:
            raise RuntimeError(f"{table} upsert {r.status_code}: {r.text[:300]}")

    def patch(self, table: str, match: dict, values: dict):
        r = HTTP.patch(f"{self.url}/{table}", params={k: f"eq.{v}" for k, v in match.items()},
                       json=values, headers=self.h, timeout=60)
        r.raise_for_status()


# ── External data ─────────────────────────────────────────────────────
def fetch_weather(lat: float, lng: float, today: date) -> list[dict]:
    r = HTTP.get("https://api.open-meteo.com/v1/forecast", timeout=60, params={
        "latitude": round(lat, 4), "longitude": round(lng, 4), "daily": ",".join(WEATHER_VARS),
        "timezone": "Asia/Kolkata", "past_days": 7, "forecast_days": 7, "wind_speed_unit": "kmh"})
    r.raise_for_status()
    d = r.json()["daily"]
    rows = []
    for i, ds in enumerate(d["time"]):
        day = date.fromisoformat(ds)
        row = {"day": day, "is_forecast": day >= today}
        for var, col in zip(WEATHER_VARS, WEATHER_COLS):
            v = (d.get(var) or [None] * len(d["time"]))[i]
            row[col] = round(v, 2) if v is not None else None
        rows.append(row)
    return rows


def fetch_soil(lat: float, lng: float) -> dict:
    params = [("lon", round(lng, 5)), ("lat", round(lat, 5)), ("value", "mean")]
    params += [("property", p) for p in agro.SOIL_PROPS]
    params += [("depth", dpt) for dpt in agro.DEPTH_W]
    for attempt in range(3):
        r = HTTP.get("https://rest.isric.org/soilgrids/v2.0/properties/query", params=params, timeout=90)
        if r.status_code == 429:                    # SoilGrids allows ~5 requests/minute
            time.sleep(20 * (attempt + 1))
            continue
        r.raise_for_status()
        js = r.json()
        return {**agro.parse_soilgrids(js), "raw": js.get("properties")}
    raise RuntimeError("SoilGrids rate-limited")


def send_whatsapp(to_mobile: str, body: str):
    sid, tok = os.environ["TWILIO_ACCOUNT_SID"], os.environ["TWILIO_AUTH_TOKEN"]
    frm = os.environ["TWILIO_WHATSAPP_FROM"]
    r = HTTP.post(f"https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json", auth=(sid, tok), timeout=30,
                  data={"From": f"whatsapp:{frm.replace('whatsapp:', '')}", "To": f"whatsapp:{to_mobile}", "Body": body[:1550]})
    if r.status_code >= 300:
        raise RuntimeError(f"Twilio {r.status_code}: {r.text[:200]}")


# ── Per-farm processing ──────────────────────────────────────────────
def process_farm(supa: Supa, farm: dict, catalog: dict[str, dict], today: date) -> dict:
    fid, farmer = farm["id"], farm["farmer_id"]
    area = float(farm["area_acres"])
    result = {"farm": farm["plot_name"], "weather_days": 0, "soil": False, "advisories": 0}

    # 1. weather
    wx = fetch_weather(farm["lat"], farm["lng"], today)
    supa.upsert("ff_weather_daily", [{**w, "farm_id": fid, "day": w["day"].isoformat(),
                                      "fetched_at": datetime.now(timezone.utc).isoformat()} for w in wx],
                "farm_id,day")
    result["weather_days"] = len(wx)
    forecast = [w for w in wx if w["day"] >= today]

    # 2. soil (once)
    existing = supa.get("ff_soil_profiles", farm_id=f"eq.{fid}", select="farm_id,ph,soc_g_kg,texture")
    soil = existing[0] if existing else None
    if not soil:
        try:
            soil = fetch_soil(farm["lat"], farm["lng"])
            if soil.get("ph") is not None:
                supa.upsert("ff_soil_profiles", {**soil, "farm_id": fid}, "farm_id")
            else:
                log.warning("no SoilGrids data at %s (water/urban pixel?)", farm["plot_name"])
                soil = None
            time.sleep(13)
        except Exception as e:
            log.warning("soil fetch failed for %s: %s", farm["plot_name"], e)
            soil = None
    result["soil"] = bool(soil)

    # 3. advisories
    crops = supa.get("ff_farm_crops", farm_id=f"eq.{fid}", status="eq.growing")
    advs: list[agro.Advisory] = []
    for fc in crops:
        crop = catalog[fc["crop_key"]]
        sown = date.fromisoformat(fc["sown_on"])
        stage, _days, harvest = agro.stage_of(crop, sown, today)
        if stage == "not_sown":
            continue
        advs += agro.calendar_advisories(crop, sown, today)
        advs += agro.weather_advisories(forecast, today, area, crop, stage, (harvest - today).days)
        if soil:
            advs += agro.soil_advisories(crop, sown, area, soil, today)
    if not crops:
        advs += agro.weather_advisories(forecast, today, area)
        sw = agro.sow_window_advisory(list(catalog.values()), forecast, soil, today)
        if sw:
            advs.append(sw)
        if soil:
            advs += agro.soil_advisories(None, None, area, soil, today)

    # one row per (kind, valid_for); keep the most severe if two crops collide
    rank = {"info": 0, "warn": 1, "alert": 2}
    uniq: dict[tuple, agro.Advisory] = {}
    for a in advs:
        k = (a.kind, a.valid_for)
        if k not in uniq or rank[a.severity] > rank[uniq[k].severity]:
            uniq[k] = a
    supa.upsert("ff_advisories", [a.row(fid, farmer) for a in uniq.values()], "farm_id,kind,valid_for")
    result["advisories"] = len(uniq)
    return result


def push_alerts(supa: Supa, today: date, farm_ids: set[str]):
    pending = supa.get("ff_advisories", sent_at="is.null", severity="in.(warn,alert)",
                       valid_for=f"gte.{today.isoformat()}", order="valid_for.asc")
    pending = [p for p in pending if p["farm_id"] in farm_ids]
    names = {f["id"]: f["plot_name"] for f in supa.get("ff_farms", select="id,plot_name")}
    rank = {"alert": 0, "warn": 1}
    pending.sort(key=lambda p: (rank[p["severity"]], p["valid_for"]))
    by_farmer: dict[str, list[dict]] = {}
    for p in pending:
        by_farmer.setdefault(p["farmer_id"], []).append(p)
    for farmer_id, items in by_farmer.items():
        f = supa.get("ff_farmers", id=f"eq.{farmer_id}", select="mobile,name")
        if not f or not f[0].get("mobile"):
            continue
        multi = len({i["farm_id"] for i in items}) > 1
        body = f"🌾 FarmFeast alerts, {f[0]['name']}:\n\n" + "\n\n".join(
            (f"📍 {names.get(i['farm_id'], '')}\n" if multi else "") + i["message"] for i in items[:4])
        try:
            send_whatsapp(f[0]["mobile"], body)
            for i in items[:4]:
                supa.patch("ff_advisories", {"id": i["id"]}, {"sent_at": datetime.now(timezone.utc).isoformat()})
            log.info("pushed %d alerts to farmer %s", min(4, len(items)), farmer_id[:8])
        except Exception as e:
            log.warning("push failed for farmer %s: %s", farmer_id[:8], e)


def run() -> int:
    supa = Supa()
    today = today_ist()
    catalog = {c["crop_key"]: c for c in supa.get("ff_crop_catalog")}
    params = {"source": "eq.test"} if os.getenv("ONLY_TEST_FARMS", "").lower() == "true" else {}
    farms = supa.get("ff_farms_points", **params)
    log.info("farms: %d · crops in catalogue: %d · date %s", len(farms), len(catalog), today)
    failures = 0
    for farm in farms:
        try:
            r = process_farm(supa, farm, catalog, today)
            log.info("✓ %-28s weather=%d soil=%s advisories=%d", r["farm"], r["weather_days"], r["soil"], r["advisories"])
        except Exception as e:
            failures += 1
            log.exception("✗ %s failed: %s", farm["plot_name"], e)
    if os.getenv("SEND_ALERTS", "").lower() == "true":
        push_alerts(supa, today, {f["id"] for f in farms})
    log.info("done · %d farms · %d failed", len(farms), failures)
    return 1 if farms and failures == len(farms) else 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sys.exit(run())
