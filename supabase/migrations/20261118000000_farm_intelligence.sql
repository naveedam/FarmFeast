-- FarmFeast · Farm Intelligence layer (additive, non-breaking)
-- ------------------------------------------------------------------
-- * Does NOT alter ff_farmers or any existing table/column.
-- * Mirrors every boundary walk (ff_farmers.farm_boundary) into ff_farms
--   via an AFTER trigger wrapped in an exception guard, so a failure here
--   can never block the existing webhook update.
-- * Accurate geodesic area via PostGIS geography (ST_Area in m²).
-- ------------------------------------------------------------------

create extension if not exists postgis;

-- ── Farms: one row per plot (farmers can own several plots) ─────────
create table if not exists public.ff_farms (
  id            uuid primary key default gen_random_uuid(),
  farmer_id     uuid not null references public.ff_farmers(id) on delete cascade,
  plot_name     text not null default 'Main plot',
  boundary      geography(Polygon, 4326) not null,
  area_sq_m     double precision generated always as (ST_Area(boundary)) stored,
  area_acres    double precision generated always as (ST_Area(boundary) / 4046.8564224) stored,
  centroid      geography(Point, 4326) generated always as (ST_Centroid(boundary::geometry)::geography) stored,
  source        text not null default 'whatsapp_walk',   -- whatsapp_walk | agent | satellite_edit
  is_valid      boolean not null default true,
  quality_flags text[] not null default '{}',
  is_active     boolean not null default true,           -- latest boundary for this plot
  created_at    timestamptz not null default now()
);

create index if not exists ff_farms_boundary_gix on public.ff_farms using gist (boundary);
create index if not exists ff_farms_farmer_idx   on public.ff_farms (farmer_id) where is_active;

-- ── Satellite observations per farm (Sentinel-2 L2A) ────────────────
create table if not exists public.ff_satellite_indices (
  id               uuid primary key default gen_random_uuid(),
  farm_id          uuid not null references public.ff_farms(id) on delete cascade,
  scene_id         text not null,
  observed_at      timestamptz not null,
  cloud_free_pct   double precision,   -- share of farm pixels usable after cloud mask
  ndvi_mean        double precision,
  ndvi_p10         double precision,
  ndvi_p90         double precision,
  ndwi_mean        double precision,   -- McFeeters NDWI (green/NIR): surface wetness
  stressed_pct     double precision,   -- share of pixels well below farm median
  pixel_count      integer,
  created_at       timestamptz not null default now(),
  unique (farm_id, scene_id)
);

create index if not exists ff_sat_farm_time_idx on public.ff_satellite_indices (farm_id, observed_at desc);

-- ── Geometry parser tolerant of text WKT or geometry column ─────────
create or replace function public.ff_parse_boundary(p anyelement)
returns geometry language plpgsql immutable as $$
declare t text := p::text;
begin
  if t is null or t = '' then return null; end if;
  if upper(t) like 'POLYGON%' or upper(t) like 'SRID=%' then
    return ST_SetSRID(ST_GeomFromEWKT(t), 4326);
  end if;
  return ST_SetSRID(ST_GeomFromEWKB(decode(t, 'hex')), 4326);   -- geometry → hex EWKB
end $$;

-- ── Sync walk → ff_farms ───────────────────────────────────────────
create or replace function public.ff_sync_farm_from_walk()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  g      geometry;
  flags  text[] := '{}';
  acres  double precision;
begin
  begin
    g := public.ff_parse_boundary(NEW.farm_boundary);
    if g is null then return NEW; end if;

    if not ST_IsValid(g) then
      flags := array_append(flags, 'self_intersecting');
      g := ST_CollectionExtract(ST_MakeValid(g), 3);
      if GeometryType(g) = 'MULTIPOLYGON' then
        -- keep the largest ring
        select geom into g from ST_Dump(g) order by ST_Area(geom::geography) desc limit 1;
      end if;
    end if;
    if g is null or ST_IsEmpty(g) then return NEW; end if;

    acres := ST_Area(g::geography) / 4046.8564224;
    if acres < 0.05 then flags := array_append(flags, 'too_small'); end if;
    if acres > 50   then flags := array_append(flags, 'too_large'); end if;
    if ST_NPoints(g) - 1 < 4 then flags := array_append(flags, 'few_points'); end if;

    update public.ff_farms set is_active = false
     where farmer_id = NEW.id and plot_name = 'Main plot' and is_active;

    insert into public.ff_farms (farmer_id, boundary, is_valid, quality_flags)
    values (NEW.id, g::geography,
            not (flags && array['too_small','too_large']), flags);
  exception when others then
    raise warning 'ff_sync_farm_from_walk skipped for farmer %: %', NEW.id, sqlerrm;
  end;
  return NEW;
end $$;

drop trigger if exists ff_farmers_boundary_sync on public.ff_farmers;
create trigger ff_farmers_boundary_sync
  after insert or update of farm_boundary on public.ff_farmers
  for each row when (NEW.farm_boundary is not null)
  execute function public.ff_sync_farm_from_walk();

-- ── Backfill farms from walks already captured ─────────────────────
do $$
declare r record;
begin
  for r in select * from public.ff_farmers
           where farm_boundary is not null
             and not exists (select 1 from public.ff_farms f where f.farmer_id = ff_farmers.id)
  loop
    update public.ff_farmers set farm_boundary = farm_boundary where id = r.id;  -- fires trigger
  end loop;
end $$;

-- ── Worker-facing view (GeoJSON) ───────────────────────────────────
create or replace view public.ff_farms_geojson as
select f.id, f.farmer_id, f.plot_name, f.area_acres,
       ST_AsGeoJSON(f.boundary)::json as geojson
  from public.ff_farms f
 where f.is_active and f.is_valid;

-- ── Latest health per farm (for webhook + admin) ───────────────────
create or replace view public.ff_farm_health_latest as
select distinct on (f.id)
       f.id as farm_id, f.farmer_id, f.plot_name, f.area_acres,
       s.observed_at, s.ndvi_mean, s.ndwi_mean, s.stressed_pct, s.cloud_free_pct,
       lag_s.ndvi_mean as prev_ndvi_mean, lag_s.observed_at as prev_observed_at
  from public.ff_farms f
  join public.ff_satellite_indices s on s.farm_id = f.id and s.cloud_free_pct >= 0.6
  left join lateral (
       select p.ndvi_mean, p.observed_at from public.ff_satellite_indices p
        where p.farm_id = f.id and p.cloud_free_pct >= 0.6 and p.observed_at < s.observed_at
        order by p.observed_at desc limit 1) lag_s on true
 where f.is_active
 order by f.id, s.observed_at desc;

-- ── RLS: service role only (webhook + worker use service key) ───────
alter table public.ff_farms enable row level security;
alter table public.ff_satellite_indices enable row level security;
