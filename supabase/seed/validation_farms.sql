-- FarmFeast · validation farms (NOT a migration — run by hand in the SQL Editor)
-- Adds 4 TEST plots in different Karnataka agro-zones to ONE existing farmer
-- (default: the earliest registered). Each has a different crop situation so
-- every advisory path gets exercised. Remove with the CLEANUP block below.
-- Plot locations are approximate test points, not verified cropland.

with me as (select id from public.ff_farmers order by created_at limit 1),
plots(plot_name, lon, lat) as (values
  ('TEST Kolar – tomato',        78.1300, 13.1300),   -- Eastern dry zone
  ('TEST Mandya – paddy',        76.9000, 12.5200),   -- Southern dry zone, canal irrigated
  ('TEST Davanagere – maize',    75.9200, 14.4600),   -- Central dry zone
  ('TEST Hassan – no crop yet',  76.1000, 13.0000)    -- Southern transition zone
)
insert into public.ff_farms (farmer_id, plot_name, boundary, source)
select me.id, p.plot_name,
       ST_MakeEnvelope(p.lon, p.lat, p.lon + 0.000586, p.lat + 0.000575, 4326)::geography,  -- ≈1 acre
       'test'
  from me, plots p
 where not exists (select 1 from public.ff_farms f where f.plot_name = p.plot_name and f.source = 'test');

-- Crops at different stages
insert into public.ff_farm_crops (farm_id, crop_key, sown_on, source)
select f.id, x.crop_key, current_date - x.days_ago, 'test'
  from public.ff_farms f
  join (values ('TEST Kolar – tomato',     'tomato', 55),   -- mid-season (flowering)
               ('TEST Mandya – paddy',     'paddy', 100),   -- late season
               ('TEST Davanagere – maize', 'maize', 104)    -- harvest within ~6 days → harvest-rain logic
       ) x(plot_name, crop_key, days_ago) on x.plot_name = f.plot_name
 where f.source = 'test'
   and not exists (select 1 from public.ff_farm_crops c where c.farm_id = f.id);

select plot_name, round(area_acres::numeric, 2) as acres from public.ff_farms where source = 'test';

-- ── CLEANUP (run when validation is finished) ──────────────────────
-- delete from public.ff_farms where source = 'test';   -- cascades crops, weather, soil, advisories, NDVI
