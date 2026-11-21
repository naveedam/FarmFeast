"""
FarmFeast · Sentinel-2 crop-health worker
-----------------------------------------
For every active farm polygon (ff_farms_geojson), find recent Sentinel-2 L2A
scenes on Microsoft Planetary Computer (free, no key), cloud-mask with the SCL
band, and store per-farm NDVI / NDWI statistics in ff_satellite_indices.

Env:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (required)
  LOOKBACK_DAYS   default 20
  MAX_CLOUD       scene-level cloud %, default 60
Run:
  python ndvi_worker.py
"""
from __future__ import annotations

import os
import sys
import logging
from datetime import datetime, timedelta, timezone

import numpy as np

log = logging.getLogger("ndvi")

# SCL classes kept: 4 vegetation, 5 bare soil, 6 water, 7 unclassified
SCL_VALID = {4, 5, 6, 7}
STRESS_DROP = 0.15          # pixel NDVI this far below farm median = stressed
MIN_PIXELS = 4


# ── pure maths (unit-tested) ──────────────────────────────────────────
def compute_stats(red, nir, green, scl, inside, offset: float = 0.0) -> dict | None:
    """All arrays same shape, raw L2A DN. `offset` is added to DN (e.g. -1000 for baseline >= 04.00)."""
    raw_ok = (red > 0) & (nir > 0)          # DN 0 = nodata
    red, nir, green = (a.astype("float64") + offset for a in (red, nir, green))
    inside = inside.astype(bool)
    total = int(inside.sum())
    if total == 0:
        return None
    clear = inside & raw_ok & np.isin(scl, list(SCL_VALID)) & (nir + red > 0)
    n = int(clear.sum())
    cloud_free = n / total
    if n < MIN_PIXELS:
        return {"cloud_free_pct": cloud_free, "pixel_count": n}
    with np.errstate(divide="ignore", invalid="ignore"):
        ndvi = (nir - red) / (nir + red)
        ndwi = (green - nir) / (green + nir)
    v = ndvi[clear]
    w = ndwi[clear & np.isfinite(ndwi)]
    med = float(np.median(v))
    return {
        "cloud_free_pct": round(cloud_free, 4),
        "ndvi_mean": round(float(v.mean()), 4),
        "ndvi_p10": round(float(np.percentile(v, 10)), 4),
        "ndvi_p90": round(float(np.percentile(v, 90)), 4),
        "ndwi_mean": round(float(w.mean()), 4) if w.size else None,
        "stressed_pct": round(float((v < med - STRESS_DROP).mean()), 4),
        "pixel_count": n,
    }


# ── Supabase REST ──────────────────────────────────────────────────────
class Supa:
    def __init__(self):
        import requests
        self.s = requests.Session()
        self.url = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1"
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        self.s.headers.update({"apikey": key, "Authorization": f"Bearer {key}"})

    def farms(self) -> list[dict]:
        r = self.s.get(f"{self.url}/ff_farms_geojson", params={"select": "*"}, timeout=60)
        r.raise_for_status()
        return r.json()

    def seen_scenes(self, farm_id: str) -> set[str]:
        r = self.s.get(f"{self.url}/ff_satellite_indices",
                       params={"select": "scene_id", "farm_id": f"eq.{farm_id}"}, timeout=60)
        r.raise_for_status()
        return {x["scene_id"] for x in r.json()}

    def insert(self, row: dict):
        r = self.s.post(f"{self.url}/ff_satellite_indices", json=row, timeout=60,
                        headers={"Prefer": "resolution=ignore-duplicates"})
        r.raise_for_status()


# ── raster reading ──────────────────────────────────────────────────────
def read_band(href, geom_wgs84, shape=None):
    """Read the farm window of a COG band; returns (array, transform, crs)."""
    import rasterio
    from rasterio.windows import from_bounds
    from rasterio.enums import Resampling
    from rasterio.warp import transform_geom
    from shapely.geometry import shape as shp

    with rasterio.open(href) as src:
        g = transform_geom("EPSG:4326", src.crs, geom_wgs84)
        minx, miny, maxx, maxy = shp(g).buffer(20).bounds
        win = from_bounds(minx, miny, maxx, maxy, src.transform).round_offsets().round_lengths()
        kw = {"window": win, "boundless": True, "fill_value": 0}
        if shape:
            kw.update(out_shape=shape, resampling=Resampling.nearest)
        arr = src.read(1, **kw)
        tr = src.window_transform(win)
        if shape:
            tr = tr * tr.scale(win.width / shape[1], win.height / shape[0])
        return arr, tr, src.crs, g


def process_item(item, geom):
    from rasterio.features import geometry_mask
    red, tr, _crs, g_proj = read_band(item.assets["B04"].href, geom)
    shape = red.shape
    nir = read_band(item.assets["B08"].href, geom)[0]
    green = read_band(item.assets["B03"].href, geom)[0]
    scl = read_band(item.assets["SCL"].href, geom, shape=shape)[0]
    inside = geometry_mask([g_proj], out_shape=shape, transform=tr, invert=True, all_touched=False)
    if inside.sum() == 0:   # tiny plot: fall back to touched pixels
        inside = geometry_mask([g_proj], out_shape=shape, transform=tr, invert=True, all_touched=True)
    return compute_stats(red, nir, green, scl, inside, offset=dn_offset(item))


def dn_offset(item) -> float:
    """Processing baseline 04.00+ (from 25-Jan-2022) adds +1000 to L2A DN."""
    try:
        return -1000.0 if float(item.properties.get("s2:processing_baseline", "0")) >= 4.0 else 0.0
    except ValueError:
        return 0.0


def run():
    import planetary_computer
    import pystac_client

    lookback = int(os.getenv("LOOKBACK_DAYS", "20"))
    max_cloud = float(os.getenv("MAX_CLOUD", "60"))
    supa = Supa()
    cat = pystac_client.Client.open("https://planetarycomputer.microsoft.com/api/stac/v1",
                                    modifier=planetary_computer.sign_inplace)
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=lookback)
    farms = supa.farms()
    log.info("farms to process: %d", len(farms))
    written = 0
    for f in farms:
        geom = f["geojson"]
        try:
            seen = supa.seen_scenes(f["id"])
            items = cat.search(collections=["sentinel-2-l2a"], intersects=geom,
                               datetime=f"{start:%Y-%m-%d}/{end:%Y-%m-%d}",
                               query={"eo:cloud_cover": {"lt": max_cloud}}).item_collection()
            for it in sorted(items, key=lambda i: i.datetime):
                if it.id in seen:
                    continue
                stats = process_item(it, geom)
                if not stats:
                    continue
                supa.insert({"farm_id": f["id"], "scene_id": it.id,
                             "observed_at": it.datetime.isoformat(), **stats})
                written += 1
                log.info("farm %s %s ndvi=%s clear=%s", f["id"][:8], it.datetime.date(),
                         stats.get("ndvi_mean"), stats["cloud_free_pct"])
        except Exception as e:  # one bad farm must not stop the run
            log.exception("farm %s failed: %s", f["id"], e)
    log.info("done, %d observations written", written)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    sys.exit(run())
