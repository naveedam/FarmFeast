# Farm Intelligence 2 — weather alerts · crop calendar · soil analytics

Additive. Existing tables, the walk flow, HEALTH, STATUS, PRICE and voice listings are unchanged.

## What farmers get on WhatsApp
| Command | Kannada alias | Reply |
|---|---|---|
| `WEATHER` | `HAVAMANA` | 3-day forecast per plot + active alerts (most urgent first) |
| `CROP` | `BELE` | Stage, progress bar, expected harvest date; sowing suggestions if nothing is sown |
| `SOIL` | `MANNU` | pH, organic carbon, texture + Urea/DAP/MOP for the plot's real acreage |
| `SOWN: Tomato` / `SOWN: Ragi 05-11` | `BITTHANE:` | Records sowing (Kannada/English crop names) and predicts harvest |
| `MENU` / `HELP` | | Lists every command |

## Alerts generated daily (05:53 IST)
heavy rain (≥25 mm warn, ≥50 mm alert) · rain within 5 days of harvest · heat above the crop's stress
temperature · dry week with irrigation **litres for the farm's area** (FAO-56 ET0 × crop Kc) · strong wind ·
best spraying day · stage changes · harvest due within 7 days · sowing window (season + soil pH + rain) ·
fertiliser plan (N adjusted for organic carbon) · soil pH outside the crop's range.

Data: Open-Meteo (weather, ET0) and ISRIC SoilGrids v2 (soil, 250 m, 0–30 cm). 12 Karnataka crops in
`ff_crop_catalog` — edit that table to add crops or tune numbers.

## Deploy (browser only)
1. Supabase → SQL Editor → run `supabase/migrations/20261121000000_weather_calendar_soil.sql`.
2. Supabase → Edge Functions → ff-whatsapp-webhook → Code → paste the new `index.ts` → Deploy.
3. Validation: SQL Editor → run `supabase/seed/validation_farms.sql` (4 TEST plots on your farmer account),
   then GitHub → Actions → **Farm intelligence** → Run workflow (leave "only TEST farms" ticked).
   The run page shows a PASS/FAIL report per farm. Then send MENU, WEATHER, CROP, SOIL on WhatsApp.
4. Cleanup: `delete from ff_farms where source = 'test';`

## Optional: push alerts to WhatsApp
Off by default. To switch on: GitHub → Settings → Secrets and variables → Actions →
Secrets: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` (e.g. +14155238886);
Variables: `SEND_ALERTS` = `true`. Max 4 warn/alert messages per farmer per day, never repeated.
Twilio sandbox only delivers to numbers that joined recently; production needs an approved
WhatsApp template for messages sent outside a 24-hour reply window.

## Caveats
- Crop numbers, thresholds and romanised Kannada are indicative — have an agronomist and a native
  speaker review `ff_crop_catalog` and `workers/farmintel/agro.py` before scaling.
- SoilGrids is a 250 m modelled estimate, not a lab test; replies say so.
- Open-Meteo's free API is for non-commercial use; a commercial launch needs their paid plan (or IMD).
