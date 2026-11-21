"""
FarmFeast · Farm Intelligence validation report
Checks weather, soil, crop calendar and advisories for each farm (default: TEST farms)
and prints a PASS/FAIL table — also written to the GitHub Actions run summary.
Exit code 1 if any check fails.
"""
from __future__ import annotations

import os
import sys
from datetime import date

from farm_intel import Supa, today_ist

RANGES = {"tmax_c": (5, 50), "tmin_c": (-5, 40), "rain_mm": (0, 500), "et0_mm": (0, 15),
          "wind_max_kmh": (0, 150), "rain_prob_pct": (0, 100)}


def check_farm(supa: Supa, farm: dict, today: date) -> tuple[list[tuple[str, bool, str]], dict]:
    fid = farm["id"]
    checks: list[tuple[str, bool, str]] = []
    wx = supa.get("ff_weather_daily", farm_id=f"eq.{fid}", order="day.asc")
    fut = [w for w in wx if w["day"] >= today.isoformat()]
    checks.append(("Weather: 7-day forecast", len(fut) >= 6, f"{len(fut)} forecast days, {len(wx) - len(fut)} past"))
    bad = [f"{w['day']} {k}={w[k]}" for w in wx for k, (lo, hi) in RANGES.items()
           if w.get(k) is not None and not lo <= w[k] <= hi]
    checks.append(("Weather: values in range", not bad and bool(wx), ", ".join(bad[:3]) or "ok"))
    checks.append(("Weather: ET0 present", any(w.get("et0_mm") for w in fut), "needed for irrigation volume"))

    soil = supa.get("ff_soil_profiles", farm_id=f"eq.{fid}")
    s = soil[0] if soil else {}
    checks.append(("Soil: profile fetched", bool(s), s.get("texture") or "missing"))
    if s:
        tot = sum(s.get(k) or 0 for k in ("clay_pct", "sand_pct", "silt_pct"))
        checks.append(("Soil: pH plausible", s.get("ph") is not None and 3.5 <= s["ph"] <= 10, f"pH {s.get('ph')}"))
        checks.append(("Soil: texture adds to ~100%", 90 <= tot <= 110, f"{tot:.0f}%"))

    crops = supa.get("ff_farm_crop_status", farm_id=f"eq.{fid}")
    advs = supa.get("ff_advisories", farm_id=f"eq.{fid}")
    kinds = {a["kind"] for a in advs}
    if crops:
        c = crops[0]
        expected = (date.fromisoformat(c["sown_on"]).toordinal() + c["duration_days"])
        checks.append(("Calendar: stage computed", bool(c.get("stage")),
                       f"{c['name_en']} {c['stage']} day {c['days_since_sowing']}, harvest {c['expected_harvest']}"))
        checks.append(("Calendar: harvest date consistent",
                       date.fromisoformat(c["expected_harvest"]).toordinal() == expected, ""))
        checks.append(("Advisory: stage message", "stage" in kinds or "harvest_due" in kinds, ""))
        if s:
            fert = next((a for a in advs if a["kind"] == "fertiliser"), None)
            checks.append(("Advisory: fertiliser plan", bool(fert),
                           (f"Urea {fert['data']['urea_kg']} / DAP {fert['data']['dap_kg']} / "
                            f"MOP {fert['data']['mop_kg']} kg") if fert else "missing"))
    else:
        checks.append(("Advisory: sowing window", "sow_window" in kinds,
                       next((", ".join(a["data"]["crops"]) for a in advs if a["kind"] == "sow_window"), "none")))
    too_long = [a["kind"] for a in advs if len(a["message"]) > 700]
    checks.append(("Advisories: WhatsApp-sized", not too_long, ", ".join(too_long) or f"{len(advs)} advisories"))
    return checks, {a["kind"]: a["severity"] for a in advs}


def main() -> int:
    supa = Supa()
    today = today_ist()
    only_test = os.getenv("VALIDATE_ALL", "").lower() != "true"
    farms = supa.get("ff_farms_points", **({"source": "eq.test"} if only_test else {}))
    lines = [f"## Farm Intelligence validation — {today}", ""]
    if not farms:
        lines.append("No farms found. Run `supabase/seed/validation_farms.sql` first.")
        print("\n".join(lines))
        return 1
    failed = 0
    for farm in farms:
        checks, kinds = check_farm(supa, farm, today)
        ok = all(c[1] for c in checks)
        failed += not ok
        lines += [f"### {'✅' if ok else '❌'} {farm['plot_name']} ({farm['area_acres']:.2f} ac, "
                  f"{farm['lat']:.3f}, {farm['lng']:.3f})", "", "| Check | Result | Detail |", "|---|---|---|"]
        lines += [f"| {n} | {'PASS' if p else 'FAIL'} | {d} |" for n, p, d in checks]
        lines += ["", "Advisories: " + (", ".join(f"`{k}` ({v})" for k, v in sorted(kinds.items())) or "none"), ""]
    lines.append(f"**{len(farms) - failed}/{len(farms)} farms passed**")
    report = "\n".join(lines)
    print(report)
    if os.getenv("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as fh:
            fh.write(report + "\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
