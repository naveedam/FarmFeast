"""
FarmFeast agronomy rules — pure functions, no I/O (fully unit-tested).

All thresholds are INDICATIVE defaults for Karnataka smallholdings and should be
reviewed by an agronomist before farmers rely on them. Kannada is romanised to
match the existing bot; have a native speaker review wording.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

ACRE_M2 = 4046.8564224
ACRE_HA = 0.40468564224

STAGE_KN = {
    "initial": "Modala hantha", "development": "Beleyuva hantha",
    "mid_season": "Madhya hantha", "late_season": "Koneya hantha",
    "harvest_due": "Koylu hantha",
}
STAGE_EN = {
    "initial": "Establishment", "development": "Vegetative growth",
    "mid_season": "Flowering / fruiting", "late_season": "Maturity",
    "harvest_due": "Ready to harvest",
}
STAGE_FRAC = {"initial": 0.0, "development": 0.15, "mid_season": 0.40, "late_season": 0.80}


def fmt_day(d: date) -> str:
    return f"{d.day} {d.strftime('%b')}"


@dataclass
class Advisory:
    kind: str
    severity: str          # info | warn | alert
    valid_for: date
    message: str
    data: dict

    def row(self, farm_id: str, farmer_id: str) -> dict:
        return {"farm_id": farm_id, "farmer_id": farmer_id, "kind": self.kind,
                "severity": self.severity, "valid_for": self.valid_for.isoformat(),
                "message": self.message, "data": self.data}


# ── Soil ──────────────────────────────────────────────────────────────
SOIL_PROPS = {  # SoilGrids property → our column
    "phh2o": "ph", "soc": "soc_g_kg", "nitrogen": "nitrogen_g_kg",
    "clay": "clay_pct", "sand": "sand_pct", "silt": "silt_pct", "cec": "cec_cmol_kg",
}
DEPTH_W = {"0-5cm": 5, "5-15cm": 10, "15-30cm": 15}   # thickness-weighted 0–30 cm


def parse_soilgrids(js: dict) -> dict:
    """SoilGrids v2 /properties/query JSON → our soil columns (conventional units)."""
    out: dict = {}
    for layer in js.get("properties", {}).get("layers", []):
        col = SOIL_PROPS.get(layer.get("name"))
        if not col:
            continue
        # d_factor converts mapped integers to conventional units:
        # pH×10→pH, soc dg/kg→g/kg, nitrogen cg/kg→g/kg, clay/sand/silt g/kg→%, cec mmol(c)/kg→cmol(c)/kg
        factor = layer.get("unit_measure", {}).get("d_factor", 1) or 1
        tot = wsum = 0.0
        for d in layer.get("depths", []):
            w = DEPTH_W.get(d.get("label"))
            v = (d.get("values") or {}).get("mean")
            if w and v is not None:
                tot += v / factor * w
                wsum += w
        if wsum:
            out[col] = round(tot / wsum, 2)
    if all(k in out for k in ("clay_pct", "sand_pct", "silt_pct")):
        out["texture"] = texture_class(out["sand_pct"], out["silt_pct"], out["clay_pct"])
    return out


def texture_class(sand: float, silt: float, clay: float) -> str:
    """USDA soil texture triangle."""
    if silt + 1.5 * clay < 15:
        return "sand"
    if silt + 2 * clay < 30:
        return "loamy sand"
    if (7 <= clay < 20 and sand > 52) or (clay < 7 and silt < 50):
        return "sandy loam"
    if 7 <= clay < 27 and 28 <= silt < 50 and sand <= 52:
        return "loam"
    if silt >= 80 and clay < 12:
        return "silt"
    if (silt >= 50 and 12 <= clay < 27) or (50 <= silt < 80 and clay < 12):
        return "silt loam"
    if 20 <= clay < 35 and silt < 28 and sand > 45:
        return "sandy clay loam"
    if 27 <= clay < 40 and 20 < sand <= 45:
        return "clay loam"
    if 27 <= clay < 40 and sand <= 20:
        return "silty clay loam"
    if clay >= 35 and sand > 45:
        return "sandy clay"
    if clay >= 40 and silt >= 40:
        return "silty clay"
    return "clay"


def soc_class(soc_g_kg: float | None) -> str | None:
    """Indian OC% bands: <0.5 low, 0.5–0.75 medium, >0.75 high (g/kg = %×10)."""
    if soc_g_kg is None:
        return None
    return "low" if soc_g_kg < 5 else "medium" if soc_g_kg <= 7.5 else "high"


def ph_class(ph: float | None) -> str | None:
    if ph is None:
        return None
    return ("strongly acidic" if ph < 5.5 else "slightly acidic" if ph < 6.5 else
            "neutral" if ph <= 7.5 else "alkaline" if ph <= 8.5 else "strongly alkaline")


N_FACTOR = {"low": 1.25, "medium": 1.0, "high": 0.75, None: 1.0}


def fertiliser_plan(crop: dict, area_acres: float, soil: dict | None) -> dict:
    """NPK for the farm's real area → Urea / DAP / MOP, N adjusted by soil organic carbon."""
    ha = area_acres * ACRE_HA
    oc = soc_class((soil or {}).get("soc_g_kg"))
    n = float(crop["n_kg_ha"]) * N_FACTOR[oc] * ha
    p = float(crop["p2o5_kg_ha"]) * ha
    k = float(crop["k2o_kg_ha"]) * ha
    dap = p / 0.46
    urea = max(0.0, (n - dap * 0.18) / 0.46)
    mop = k / 0.60
    return {"n_kg": round(n, 1), "p2o5_kg": round(p, 1), "k2o_kg": round(k, 1),
            "urea_kg": round(urea), "dap_kg": round(dap), "mop_kg": round(mop),
            "oc_class": oc, "n_factor": N_FACTOR[oc]}


def soil_advisories(crop: dict | None, sown_on: date | None, area_acres: float,
                    soil: dict, today: date) -> list[Advisory]:
    out: list[Advisory] = []
    ph = soil.get("ph")
    anchor = sown_on or today
    if crop:
        plan = fertiliser_plan(crop, area_acres, soil)
        oc_note = {"low": " (N +25%: low organic carbon)", "high": " (N −25%: high organic carbon)"}.get(plan["oc_class"], "")
        late = sown_on is not None and (today - sown_on).days > 40
        plan["for_next_season"] = late
        out.append(Advisory(
            "fertiliser", "info", anchor,
            (f"🧪 Mundina beleige gobbara — {crop['name_kn']}, {area_acres:.2f} acre:\n" if late else
             f"🧪 Gobbara — {crop['name_kn']}, {area_acres:.2f} acre:\n") +
            f"Urea {plan['urea_kg']} kg · DAP {plan['dap_kg']} kg · MOP {plan['mop_kg']} kg{oc_note}\n"
            f"Bitthane samaya: DAP + MOP + ardha Urea. 30 dina nantara ulida Urea.\n"
            f"({'Next-season plan: f' if late else 'F'}ertiliser for {crop['name_en']} on {area_acres:.2f} acres. Apply DAP, MOP and half the "
            f"Urea at sowing; the rest of the Urea ~30 days later. Indicative — confirm with a soil test.)",
            plan))
        if ph is not None and not (float(crop["ph_min"]) <= ph <= float(crop["ph_max"])):
            fix = "Sunna (lime) haaki" if ph < float(crop["ph_min"]) else "Gypsum haaki"
            fix_en = "apply agricultural lime" if ph < float(crop["ph_min"]) else "apply gypsum / organic matter"
            out.append(Advisory(
                "soil_ph", "warn", anchor,
                f"⚠️ Mannina pH {ph:.1f} — {crop['name_kn']}ge {crop['ph_min']}–{crop['ph_max']} beku. {fix}.\n"
                f"(Soil pH {ph:.1f} is outside the {crop['ph_min']}–{crop['ph_max']} range {crop['name_en']} prefers; {fix_en}.)",
                {"ph": ph, "ph_min": float(crop["ph_min"]), "ph_max": float(crop["ph_max"])}))
    elif ph is not None and (ph < 5.5 or ph > 8.5):
        out.append(Advisory("soil_ph", "warn", anchor,
                            f"⚠️ Mannina pH {ph:.1f} ({ph_class(ph)}). Bitthane munche sudharisi.\n"
                            f"(Soil pH {ph:.1f} is {ph_class(ph)}; correct it before sowing.)", {"ph": ph}))
    return out


# ── Crop calendar ─────────────────────────────────────────────────────
def kc_for_stage(crop: dict, stage: str) -> float:
    ini, mid, end = float(crop["kc_ini"]), float(crop["kc_mid"]), float(crop["kc_end"])
    return {"initial": ini, "development": (ini + mid) / 2, "mid_season": mid,
            "late_season": (mid + end) / 2, "harvest_due": end}.get(stage, mid)


def stage_of(crop: dict, sown_on: date, today: date) -> tuple[str, int, date]:
    dur = int(crop["duration_days"])
    days = (today - sown_on).days
    harvest = sown_on + timedelta(days=dur)
    if days < 0:
        return "not_sown", days, harvest
    if days > dur:
        return "harvest_due", days, harvest
    stage = "initial"
    for s, frac in STAGE_FRAC.items():
        if days >= frac * dur:
            stage = s
    return stage, days, harvest


def calendar_advisories(crop: dict, sown_on: date, today: date) -> list[Advisory]:
    stage, days, harvest = stage_of(crop, sown_on, today)
    if stage == "not_sown":
        return []
    to_harvest = (harvest - today).days
    out: list[Advisory] = []
    if stage != "harvest_due":
        start = sown_on + timedelta(days=round(STAGE_FRAC[stage] * int(crop["duration_days"])))
        out.append(Advisory(
            "stage", "info", start,
            f"🌿 {crop['name_kn']}: {STAGE_KN[stage]} (dina {days}). Koylu ~{fmt_day(harvest)} ({to_harvest} dina).\n"
            f"({crop['name_en']}: {STAGE_EN[stage]}, day {days}. Expected harvest ~{fmt_day(harvest)}, in {to_harvest} days.)",
            {"stage": stage, "day": days, "expected_harvest": harvest.isoformat()}))
    if to_harvest <= 7:
        out.append(Advisory(
            "harvest_due", "warn", harvest,
            f"🧺 {crop['name_kn']} koylige ready ~{fmt_day(harvest)}. Kelasagaararu, chila, saarige sidda maadi.\n"
            f"({crop['name_en']} should be ready to harvest around {fmt_day(harvest)}. Arrange labour, bags and transport"
            f" — and list it on FarmFeast.)",
            {"expected_harvest": harvest.isoformat(), "days_to_harvest": to_harvest}))
    return out


def sow_window_advisory(catalog: list[dict], forecast: list[dict], soil: dict | None,
                        today: date) -> Advisory | None:
    """For a plot with nothing growing: which crops are in season now, filtered by soil pH."""
    ph = (soil or {}).get("ph")
    fits = [c for c in catalog if today.month in c["sow_months"]
            and (ph is None or float(c["ph_min"]) <= ph <= float(c["ph_max"]))]
    if not fits:
        return None
    rain7 = sum((d.get("rain_mm") or 0) for d in forecast[:7])
    moisture = ("Male nirikshe ide — mannu tevavaagiruttade." if rain7 >= 20 else
                "Male kadime — neeravari iddare maatra bitthi.")
    moisture_en = (f"{rain7:.0f} mm rain expected this week — good soil moisture for sowing." if rain7 >= 20 else
                   f"Only {rain7:.0f} mm rain expected this week — sow only with irrigation.")
    names_kn = ", ".join(c["name_kn"] for c in fits[:5])
    names_en = ", ".join(c["name_en"] for c in fits[:5])
    week = today - timedelta(days=today.weekday())
    return Advisory("sow_window", "info", week,
                    f"🌱 Ee tingalu bitthalu: {names_kn}.\n{moisture}\n"
                    f"(In season to sow now{' and suited to your soil pH' if ph else ''}: {names_en}. {moisture_en} "
                    f"Reply SOWN: <crop> after sowing.)",
                    {"crops": [c["crop_key"] for c in fits], "rain_7d_mm": round(rain7, 1)})


# ── Weather alerts ────────────────────────────────────────────────────
def weather_advisories(forecast: list[dict], today: date, area_acres: float,
                       crop: dict | None = None, stage: str | None = None,
                       days_to_harvest: int | None = None) -> list[Advisory]:
    """forecast: future days ascending from today, keys day(date) tmax_c rain_mm rain_prob_pct et0_mm wind_max_kmh."""
    out: list[Advisory] = []
    fc = sorted((d for d in forecast if d["day"] >= today), key=lambda d: d["day"])
    if not fc:
        return out

    def within(n: int) -> list[dict]:          # calendar days, not list positions
        return [d for d in fc if (d["day"] - today).days < n]
    name_kn = crop["name_kn"] if crop else "bele"
    name_en = crop["name_en"] if crop else "crop"

    # Heavy rain (next 3 days)
    for d in within(3):
        mm = d.get("rain_mm") or 0
        if mm >= 25:
            sev = "alert" if mm >= 50 else "warn"
            out.append(Advisory("heavy_rain", sev, d["day"],
                                f"🌧️ Bhaari male {fmt_day(d['day'])}: ~{mm:.0f} mm. Neeru hogalu daari maadi, gobbara/spray beda.\n"
                                f"(Heavy rain ~{mm:.0f} mm on {fmt_day(d['day'])}. Clear field drainage; postpone fertiliser and spraying.)",
                                {"rain_mm": mm}))
            break

    # Rain right before harvest (next 5 days)
    if days_to_harvest is not None and days_to_harvest <= 10:
        wet = next((d for d in within(5) if (d.get("rain_mm") or 0) >= 10 and (d.get("rain_prob_pct") or 0) >= 60), None)
        if wet:
            out.append(Advisory("harvest_rain", "alert", wet["day"],
                                f"⚠️ Koylu hattira male: {fmt_day(wet['day'])} (~{wet['rain_mm']:.0f} mm). "
                                f"Adakkinta modalu {name_kn} koylu maadi athava muchhi.\n"
                                f"(Rain ~{wet['rain_mm']:.0f} mm on {fmt_day(wet['day'])}, close to harvest. Harvest {name_en} "
                                f"before then or cover harvested produce.)",
                                {"rain_mm": wet["rain_mm"], "days_to_harvest": days_to_harvest}))

    # Heat stress (next 3 days)
    limit = float(crop["heat_stress_c"]) if crop else 38.0
    hot = [d for d in within(3) if (d.get("tmax_c") or 0) >= limit]
    if hot:
        peak = max(hot, key=lambda d: d["tmax_c"])
        out.append(Advisory("heat", "warn", peak["day"],
                            f"🌡️ Hechchu bisilu {fmt_day(peak['day'])}: {peak['tmax_c']:.0f}°C. Sanje neeru haaki, mulching maadi.\n"
                            f"({peak['tmax_c']:.0f}°C on {fmt_day(peak['day'])} — above {limit:.0f}°C stress level for {name_en}. "
                            f"Irrigate in the evening and mulch.)",
                            {"tmax_c": peak["tmax_c"], "limit_c": limit}))

    # Dry spell → irrigation volume for this farm's real area
    week = within(7)
    rain7 = sum((d.get("rain_mm") or 0) for d in week)
    if crop and stage and stage != "harvest_due" and len(week) >= 5 and rain7 < 5:
        kc = kc_for_stage(crop, stage)
        need_mm = max(0.0, sum((d.get("et0_mm") or 0) * kc for d in week) - 0.8 * rain7)
        litres = need_mm * area_acres * ACRE_M2
        out.append(Advisory("dry_spell", "warn" if need_mm >= 25 else "info", fc[0]["day"],
                            f"💧 7 dina male illa. {name_kn}ge ~{litres/1000:,.0f} saavira litre neeru beku "
                            f"({need_mm:.0f} mm, {area_acres:.2f} acre).\n"
                            f"(Dry week ahead ({rain7:.0f} mm rain). {name_en} needs about {litres/1000:,.0f} thousand litres "
                            f"({need_mm:.0f} mm) over 7 days on {area_acres:.2f} acres.)",
                            {"rain_7d_mm": round(rain7, 1), "need_mm": round(need_mm, 1),
                             "litres": round(litres), "kc": kc}))

    # Strong wind (next 2 days)
    windy = next((d for d in within(2) if (d.get("wind_max_kmh") or 0) >= 40), None)
    if windy:
        out.append(Advisory("wind", "warn", windy["day"],
                            f"💨 Jaasti gaali {fmt_day(windy['day'])}: {windy['wind_max_kmh']:.0f} km/h. Spray maadabedi, gida kattiri.\n"
                            f"(Strong wind {windy['wind_max_kmh']:.0f} km/h on {fmt_day(windy['day'])}. Don't spray; stake tall plants.)",
                            {"wind_max_kmh": windy["wind_max_kmh"]}))

    # Spray window (growing crop only)
    if crop and stage not in (None, "harvest_due"):
        ok = next((d for d in within(3) if (d.get("rain_mm") or 0) < 1 and (d.get("rain_prob_pct") or 0) < 30
                   and (d.get("wind_max_kmh") or 99) < 15), None)
        if ok:
            out.append(Advisory("spray_window", "info", ok["day"],
                                f"✅ Spray maadalu olle dina: {fmt_day(ok['day'])} (male illa, gaali kadime).\n"
                                f"(Good spraying day: {fmt_day(ok['day'])} — dry and calm.)", {}))
    return out
