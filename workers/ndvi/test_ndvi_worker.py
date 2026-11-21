import numpy as np
from ndvi_worker import compute_stats

def mk(n=10, red=1500, nir=4000, green=1800):
    f = lambda v: np.full((n, n), v, dtype="uint16")
    return f(red), f(nir), f(green), np.full((n, n), 4, dtype="uint8"), np.ones((n, n), bool)

def test_offset_corrected_ndvi():
    r, n, g, scl, m = mk(red=1500, nir=4000)        # true 500 / 3000 after -1000
    s = compute_stats(r, n, g, scl, m, offset=-1000)
    assert abs(s["ndvi_mean"] - (3000-500)/(3000+500)) < 1e-3

def test_clouds_masked():
    r, n, g, scl, m = mk()
    scl[:5] = 9                                      # cloud high prob
    s = compute_stats(r, n, g, scl, m)
    assert s["cloud_free_pct"] == 0.5 and s["pixel_count"] == 50

def test_outside_polygon_ignored_and_stress():
    r, n, g, scl, m = mk()
    m[:, 8:] = False
    n[0:2, 0:8] = 1600                               # weak patch inside farm
    s = compute_stats(r, n, g, scl, m)
    assert s["pixel_count"] == 80 and abs(s["stressed_pct"] - 16/80) < 1e-9

def test_all_cloud_returns_partial():
    r, n, g, scl, m = mk(); scl[:] = 8
    s = compute_stats(r, n, g, scl, m)
    assert s == {"cloud_free_pct": 0.0, "pixel_count": 0}
