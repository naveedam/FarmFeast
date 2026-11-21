# Farm Intelligence — Phase 1 (satellite crop health)

Additive layer on top of the existing app. Nothing in `ff_farmers`, the marketplace,
admin dashboard, or the WALK / DONE / STATUS / PRICE flows was changed.

## What it does
1. **Farm walk → `ff_farms`** — a DB trigger copies every boundary saved by `DONE`
   into `ff_farms` (PostGIS `geography`), with **exact geodesic acreage**
   (`ST_Area`), centroid, a GIST spatial index, multi-plot support, and quality flags
   (`self_intersecting`, `few_points`, `too_small` < 0.05 ac, `too_large` > 50 ac).
   The trigger is exception-guarded: if anything fails, the farmer's update still succeeds.
   Existing walks are backfilled when the migration runs.
2. **NDVI worker** (`workers/ndvi`) — every 2 days pulls Sentinel-2 L2A scenes
   (Microsoft Planetary Computer, free) for each farm polygon, applies the SCL cloud mask
   and the 2022+ DN offset, and stores NDVI mean/p10/p90, NDWI, cloud-free share and
   `stressed_pct` (pixels ≥ 0.15 below the farm median) in `ff_satellite_indices`.
3. **WhatsApp `HEALTH`** — farmer gets a Kannada + English report per plot:
   health band, trend vs previous clear scene, and a stressed-patch warning.

## Deploy
```bash
supabase db push                                       # applies 20261118000000_farm_intelligence.sql
supabase functions deploy ff-whatsapp-webhook --no-verify-jwt
```
GitHub → Settings → Secrets → Actions: add `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
then run **Actions → NDVI crop-health worker → Run workflow** once to seed data.

Local run: `cd workers/ndvi && pip install -r requirements.txt && python ndvi_worker.py`

## Notes / limits
- 10 m pixels: a 1-acre plot is ~40 pixels; plots under ~0.25 acre give noisy readings.
- NDVI bands are crop-stage dependent (a freshly sown field reads "low" correctly).
- The webhook's reply still shows its own approximate acreage; `ff_farms.area_acres`
  is the authoritative figure for analytics.

## Next
Weather alerts per farm (Open-Meteo/IMD) · SoilGrids soil profile per polygon ·
leaf-photo disease detection · colour NDVI map image in the HEALTH reply.
