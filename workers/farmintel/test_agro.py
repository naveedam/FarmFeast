from datetime import date, timedelta

import pytest

import agro

TODAY = date(2026, 11, 21)
TOMATO = dict(crop_key="tomato", name_en="Tomato", name_kn="Tomato", duration_days=120,
              sow_months=[1, 2, 6, 7, 10, 11], n_kg_ha=150, p2o5_kg_ha=100, k2o_kg_ha=100,
              ph_min=6.0, ph_max=7.0, heat_stress_c=35, kc_ini=0.6, kc_mid=1.15, kc_end=0.8)
RAGI = dict(TOMATO, crop_key="ragi", name_en="Ragi", name_kn="Ragi", sow_months=[6, 7, 8],
            ph_min=5.0, ph_max=8.2)
CABBAGE = dict(TOMATO, crop_key="cabbage", name_en="Cabbage", name_kn="Kosu", sow_months=[8, 9, 10, 11, 12],
               ph_min=6.0, ph_max=7.5)


def day(i, **kw):
    base = dict(day=TODAY + timedelta(days=i), tmax_c=30, tmin_c=20, rain_mm=0, rain_prob_pct=10,
                et0_mm=4.0, wind_max_kmh=10)
    base.update(kw)
    return base


def kinds(advs):
    return {a.kind: a for a in advs}


# ── soil ────────────────────────────────────────────────────────────
SOILGRIDS_SAMPLE = {"properties": {"layers": [
    {"name": "phh2o", "unit_measure": {"d_factor": 10},
     "depths": [{"label": "0-5cm", "values": {"mean": 60}}, {"label": "5-15cm", "values": {"mean": 62}},
                {"label": "15-30cm", "values": {"mean": 64}}]},
    {"name": "clay", "unit_measure": {"d_factor": 10},
     "depths": [{"label": l, "values": {"mean": 250}} for l in ("0-5cm", "5-15cm", "15-30cm")]},
    {"name": "sand", "unit_measure": {"d_factor": 10},
     "depths": [{"label": l, "values": {"mean": 600}} for l in ("0-5cm", "5-15cm", "15-30cm")]},
    {"name": "silt", "unit_measure": {"d_factor": 10},
     "depths": [{"label": l, "values": {"mean": 150}} for l in ("0-5cm", "5-15cm", "15-30cm")]},
    {"name": "soc", "unit_measure": {"d_factor": 10},
     "depths": [{"label": l, "values": {"mean": 40}} for l in ("0-5cm", "5-15cm", "15-30cm")]},
    {"name": "bdod", "unit_measure": {"d_factor": 100}, "depths": []},
]}}


def test_parse_soilgrids_units_and_depth_weighting():
    s = agro.parse_soilgrids(SOILGRIDS_SAMPLE)
    assert s["ph"] == pytest.approx((6.0 * 5 + 6.2 * 10 + 6.4 * 15) / 30, abs=0.01)
    assert s["clay_pct"] == 25 and s["sand_pct"] == 60 and s["silt_pct"] == 15
    assert s["soc_g_kg"] == 4.0
    assert s["texture"] == "sandy clay loam"


def test_parse_soilgrids_handles_missing_values():
    js = {"properties": {"layers": [{"name": "phh2o", "unit_measure": {"d_factor": 10},
                                     "depths": [{"label": "0-5cm", "values": {"mean": None}}]}]}}
    assert agro.parse_soilgrids(js) == {}


@pytest.mark.parametrize("sand,silt,clay,expected", [
    (92, 5, 3, "sand"), (80, 12, 8, "loamy sand"), (65, 25, 10, "sandy loam"), (40, 40, 20, "loam"),
    (20, 65, 15, "silt loam"), (5, 88, 7, "silt"), (30, 35, 35, "clay loam"), (10, 55, 35, "silty clay loam"),
    (50, 5, 45, "sandy clay"), (5, 45, 50, "silty clay"), (20, 20, 60, "clay"),
])
def test_texture_triangle(sand, silt, clay, expected):
    assert agro.texture_class(sand, silt, clay) == expected


def test_fertiliser_scales_with_area_and_low_carbon():
    one = agro.fertiliser_plan(TOMATO, 1.0, {"soc_g_kg": 6})        # medium OC
    two = agro.fertiliser_plan(TOMATO, 2.0, {"soc_g_kg": 6})
    low = agro.fertiliser_plan(TOMATO, 1.0, {"soc_g_kg": 3})        # low OC → +25% N
    assert one["n_kg"] == pytest.approx(150 * 0.4047, abs=0.1)
    assert two["dap_kg"] == pytest.approx(2 * one["dap_kg"], abs=1)
    assert low["n_kg"] == pytest.approx(one["n_kg"] * 1.25, abs=0.1)
    # nutrient balance: N supplied by DAP + Urea equals target
    assert one["dap_kg"] * 0.18 + one["urea_kg"] * 0.46 == pytest.approx(one["n_kg"], abs=1)
    assert one["mop_kg"] * 0.60 == pytest.approx(one["k2o_kg"], abs=1)


def test_soil_ph_warning_for_crop():
    adv = kinds(agro.soil_advisories(TOMATO, TODAY, 1.0, {"ph": 5.2, "soc_g_kg": 6}, TODAY))
    assert "fertiliser" in adv and adv["soil_ph"].severity == "warn" and "lime" in adv["soil_ph"].message
    ok = kinds(agro.soil_advisories(TOMATO, TODAY, 1.0, {"ph": 6.5}, TODAY))
    assert "soil_ph" not in ok


# ── calendar ────────────────────────────────────────────────────────
def test_stage_progression():
    assert agro.stage_of(TOMATO, TODAY, TODAY)[0] == "initial"
    assert agro.stage_of(TOMATO, TODAY - timedelta(days=30), TODAY)[0] == "development"
    assert agro.stage_of(TOMATO, TODAY - timedelta(days=60), TODAY)[0] == "mid_season"
    assert agro.stage_of(TOMATO, TODAY - timedelta(days=100), TODAY)[0] == "late_season"
    assert agro.stage_of(TOMATO, TODAY - timedelta(days=125), TODAY)[0] == "harvest_due"
    assert agro.stage_of(TOMATO, TODAY + timedelta(days=3), TODAY)[0] == "not_sown"


def test_calendar_stage_advisory_is_stable_within_a_stage():
    a1 = kinds(agro.calendar_advisories(TOMATO, TODAY - timedelta(days=50), TODAY))["stage"]
    a2 = kinds(agro.calendar_advisories(TOMATO, TODAY - timedelta(days=50), TODAY + timedelta(days=5)))["stage"]
    assert a1.valid_for == a2.valid_for            # same stage → same dedupe key
    assert a1.valid_for == TODAY - timedelta(days=50) + timedelta(days=48)


def test_harvest_due_within_week():
    adv = kinds(agro.calendar_advisories(TOMATO, TODAY - timedelta(days=115), TODAY))
    assert adv["harvest_due"].data["days_to_harvest"] == 5


def test_sow_window_filters_by_month_and_ph():
    a = agro.sow_window_advisory([TOMATO, RAGI, CABBAGE], [day(i, rain_mm=5) for i in range(7)], {"ph": 7.3}, TODAY)
    assert a.data["crops"] == ["cabbage"]           # Nov: tomato & cabbage in season; tomato pH max 7.0
    assert a.valid_for.weekday() == 0
    assert agro.sow_window_advisory([RAGI], [], None, TODAY) is None


# ── weather ─────────────────────────────────────────────────────────
def test_heavy_rain_levels():
    adv = kinds(agro.weather_advisories([day(0), day(1, rain_mm=60)], TODAY, 1.0))
    assert adv["heavy_rain"].severity == "alert" and adv["heavy_rain"].valid_for == TODAY + timedelta(days=1)
    adv = kinds(agro.weather_advisories([day(0, rain_mm=30)], TODAY, 1.0))
    assert adv["heavy_rain"].severity == "warn"
    assert "heavy_rain" not in kinds(agro.weather_advisories([day(4, rain_mm=80)], TODAY, 1.0))


def test_harvest_rain_only_near_harvest():
    fc = [day(0), day(2, rain_mm=15, rain_prob_pct=80)]
    assert "harvest_rain" in kinds(agro.weather_advisories(fc, TODAY, 1, TOMATO, "late_season", 6))
    assert "harvest_rain" not in kinds(agro.weather_advisories(fc, TODAY, 1, TOMATO, "mid_season", 40))


def test_heat_uses_crop_threshold():
    fc = [day(0, tmax_c=36)]
    assert "heat" in kinds(agro.weather_advisories(fc, TODAY, 1, TOMATO, "mid_season"))   # tomato 35
    assert "heat" not in kinds(agro.weather_advisories(fc, TODAY, 1))                     # default 38


def test_dry_spell_litres_for_real_area():
    fc = [day(i, et0_mm=5.0) for i in range(7)]
    adv = kinds(agro.weather_advisories(fc, TODAY, 2.0, TOMATO, "mid_season"))["dry_spell"]
    need = 7 * 5.0 * 1.15
    assert adv.data["need_mm"] == pytest.approx(need, abs=0.1)
    assert adv.data["litres"] == pytest.approx(need * 2.0 * agro.ACRE_M2, rel=1e-3)
    assert adv.severity == "warn"
    assert "dry_spell" not in kinds(agro.weather_advisories(fc, TODAY, 2.0))      # no crop → no irrigation advice


def test_wind_and_spray_window():
    adv = kinds(agro.weather_advisories([day(0, wind_max_kmh=45), day(1)], TODAY, 1, TOMATO, "mid_season"))
    assert adv["wind"].valid_for == TODAY
    assert adv["spray_window"].valid_for == TODAY + timedelta(days=1)


def test_past_days_ignored():
    assert agro.weather_advisories([day(-1, rain_mm=90)], TODAY, 1.0) == []


def test_fertiliser_marked_next_season_when_late():
    early = kinds(agro.soil_advisories(TOMATO, TODAY - timedelta(days=10), 1.0, {"ph": 6.5}, TODAY))["fertiliser"]
    late = kinds(agro.soil_advisories(TOMATO, TODAY - timedelta(days=60), 1.0, {"ph": 6.5}, TODAY))["fertiliser"]
    assert not early.data["for_next_season"] and late.data["for_next_season"]
    assert "Next-season" in late.message and "Next-season" not in early.message
