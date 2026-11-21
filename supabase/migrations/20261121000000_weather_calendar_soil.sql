-- FarmFeast · Farm Intelligence 2: weather alerts, crop calendar, soil analytics
-- ------------------------------------------------------------------
-- Additive only. Requires 20261118000000_farm_intelligence.sql (ff_farms).
-- No existing table or column is altered.
-- Crop figures below are INDICATIVE defaults for Karnataka (UAS/KAU-style
-- package-of-practice ranges) and should be reviewed by an agronomist.
-- ------------------------------------------------------------------

-- ── Crop catalogue (single source for worker + webhook) ─────────────
create table if not exists public.ff_crop_catalog (
  crop_key        text primary key,
  name_en         text not null,
  name_kn         text not null,              -- romanised Kannada, matches bot style
  aliases         text[] not null default '{}',
  duration_days   integer not null,           -- sowing/transplant → first harvest
  sow_months      integer[] not null,         -- 1..12, typical Karnataka windows
  n_kg_ha         numeric not null,
  p2o5_kg_ha      numeric not null,
  k2o_kg_ha       numeric not null,
  ph_min          numeric not null,
  ph_max          numeric not null,
  heat_stress_c   numeric not null,           -- daily Tmax above this stresses the crop
  kc_ini          numeric not null,
  kc_mid          numeric not null,
  kc_end          numeric not null
);

insert into public.ff_crop_catalog values
 ('tomato',    'Tomato',      'Tomato',         '{tomato,tamatar,tometo,tamato}',         120, '{1,2,6,7,10,11}',   150,100,100, 6.0,7.0, 35, 0.6,1.15,0.8),
 ('beans',     'Beans',       'Beans / Avare',  '{beans,bean,avare,huralikai,french beans}', 75, '{1,2,6,7,8,10,11}', 25, 50, 25, 6.0,7.5, 32, 0.5,1.05,0.9),
 ('radish',    'Radish',      'Moolangi',       '{radish,moolangi,mullangi,mooli}',        45, '{1,6,7,8,9,10,11,12}', 75, 50, 50, 6.0,7.5, 30, 0.7,0.90,0.85),
 ('ragi',      'Ragi',        'Ragi',           '{ragi,finger millet,raagi}',             110, '{6,7,8}',            50, 40, 25, 5.0,8.2, 38, 0.3,1.00,0.3),
 ('paddy',     'Paddy',       'Bhatta',         '{paddy,rice,bhatta,batta,bhatha}',       120, '{1,6,7,8,12}',      100, 50, 50, 5.0,7.5, 38, 1.05,1.20,0.9),
 ('maize',     'Maize',       'Mekke jola',     '{maize,corn,mekkejola,mekke jola,jola}', 110, '{6,7,10,11}',       150, 75, 40, 5.5,7.5, 38, 0.3,1.20,0.6),
 ('onion',     'Onion',       'Eerulli',        '{onion,eerulli,erulli,ullagadde}',       120, '{6,7,10,11}',       125, 50,125, 6.0,7.5, 36, 0.7,1.05,0.75),
 ('potato',    'Potato',      'Aloogadde',      '{potato,aloo,aloogadde,alugadde}',       100, '{6,7,10,11}',       125,100,125, 5.0,6.5, 30, 0.5,1.15,0.75),
 ('chilli',    'Chilli',      'Menasinakai',    '{chilli,chili,menasinakai,mensinakai}',  150, '{6,7,8,9}',         150, 75, 75, 6.0,7.5, 35, 0.6,1.05,0.9),
 ('cabbage',   'Cabbage',     'Kosu',           '{cabbage,kosu,elekosu}',                  90, '{8,9,10,11,12}',    125, 75, 75, 6.0,7.5, 30, 0.7,1.05,0.95),
 ('carrot',    'Carrot',      'Carrot',         '{carrot,gajjari}',                        90, '{1,8,9,10,11,12}',   75, 40, 60, 6.0,7.0, 30, 0.7,1.05,0.95),
 ('groundnut', 'Groundnut',   'Kadalekai',      '{groundnut,peanut,kadalekai,shenga}',    110, '{1,2,6,7}',          25, 50, 25, 6.0,7.5, 38, 0.4,1.15,0.6)
on conflict (crop_key) do nothing;

-- ── What is growing on each farm ───────────────────────────────────
create table if not exists public.ff_farm_crops (
  id          uuid primary key default gen_random_uuid(),
  farm_id     uuid not null references public.ff_farms(id) on delete cascade,
  crop_key    text not null references public.ff_crop_catalog(crop_key),
  sown_on     date not null,
  status      text not null default 'growing' check (status in ('growing','harvested','abandoned')),
  source      text not null default 'whatsapp',
  created_at  timestamptz not null default now()
);
create index if not exists ff_farm_crops_farm_idx on public.ff_farm_crops (farm_id) where status = 'growing';

-- ── Weather per farm per day (history + 7-day forecast) ────────────
create table if not exists public.ff_weather_daily (
  farm_id        uuid not null references public.ff_farms(id) on delete cascade,
  day            date not null,
  tmax_c         double precision,
  tmin_c         double precision,
  rain_mm        double precision,
  rain_prob_pct  double precision,
  et0_mm         double precision,     -- FAO-56 reference evapotranspiration
  wind_max_kmh   double precision,
  humidity_pct   double precision,
  is_forecast    boolean not null,
  fetched_at     timestamptz not null default now(),
  primary key (farm_id, day)
);

-- ── Soil profile per farm (SoilGrids 250 m, 0–30 cm weighted) ──────
create table if not exists public.ff_soil_profiles (
  farm_id        uuid primary key references public.ff_farms(id) on delete cascade,
  ph             double precision,
  soc_g_kg       double precision,     -- soil organic carbon
  nitrogen_g_kg  double precision,
  clay_pct       double precision,
  sand_pct       double precision,
  silt_pct       double precision,
  cec_cmol_kg    double precision,
  texture        text,
  source         text not null default 'soilgrids_v2',
  raw            jsonb,
  fetched_at     timestamptz not null default now()
);

-- ── Advisories (alerts, calendar, fertiliser) ──────────────────────
create table if not exists public.ff_advisories (
  id          uuid primary key default gen_random_uuid(),
  farm_id     uuid not null references public.ff_farms(id) on delete cascade,
  farmer_id   uuid not null references public.ff_farmers(id) on delete cascade,
  kind        text not null,            -- heavy_rain | harvest_rain | heat | dry_spell | wind | spray_window | sow_window | stage | harvest_due | fertiliser | soil_ph
  severity    text not null default 'info' check (severity in ('info','warn','alert')),
  valid_for   date not null,
  message     text not null,
  data        jsonb not null default '{}',
  sent_at     timestamptz,
  created_at  timestamptz not null default now(),
  unique (farm_id, kind, valid_for)
);
create index if not exists ff_adv_farmer_idx on public.ff_advisories (farmer_id, valid_for desc);

-- ── Crop status view (calendar maths lives here) ───────────────────
create or replace view public.ff_farm_crop_status as
select fc.id as farm_crop_id, fc.farm_id, f.farmer_id, f.plot_name, f.area_acres,
       fc.crop_key, c.name_en, c.name_kn, fc.sown_on, c.duration_days,
       (current_date - fc.sown_on)                         as days_since_sowing,
       (fc.sown_on + c.duration_days)                      as expected_harvest,
       (fc.sown_on + c.duration_days) - current_date       as days_to_harvest,
       least(1.0, (current_date - fc.sown_on)::numeric / c.duration_days) as progress,
       case
         when current_date < fc.sown_on                                   then 'not_sown'
         when (current_date - fc.sown_on) < 0.15 * c.duration_days         then 'initial'
         when (current_date - fc.sown_on) < 0.40 * c.duration_days         then 'development'
         when (current_date - fc.sown_on) < 0.80 * c.duration_days         then 'mid_season'
         when (current_date - fc.sown_on) <= c.duration_days               then 'late_season'
         else 'harvest_due'
       end as stage
  from public.ff_farm_crops fc
  join public.ff_farms f        on f.id = fc.farm_id and f.is_active
  join public.ff_crop_catalog c on c.crop_key = fc.crop_key
 where fc.status = 'growing';

-- Worker reads farms with centroid as plain lat/lng
create or replace view public.ff_farms_points as
select f.id, f.farmer_id, f.plot_name, f.area_acres, f.source,
       ST_Y(f.centroid::geometry) as lat, ST_X(f.centroid::geometry) as lng
  from public.ff_farms f
 where f.is_active and f.is_valid;

-- Crop name resolver for the webhook (SOWN: <crop>)
create or replace function public.ff_resolve_crop(p_name text)
returns text language sql stable as $$
  select crop_key from public.ff_crop_catalog
   where lower(trim(p_name)) = any (aliases) or lower(trim(p_name)) = crop_key
      or lower(trim(p_name)) = lower(name_en)
   limit 1
$$;

alter table public.ff_crop_catalog  enable row level security;
alter table public.ff_farm_crops    enable row level security;
alter table public.ff_weather_daily enable row level security;
alter table public.ff_soil_profiles enable row level security;
alter table public.ff_advisories    enable row level security;
