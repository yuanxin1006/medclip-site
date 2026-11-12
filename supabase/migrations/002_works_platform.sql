begin;

create table if not exists public.works (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  body text not null default '',
  source_music_track_id uuid references public.music_tracks (id) on delete set null,
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint works_title_not_blank check (char_length(btrim(title)) between 1 and 200),
  constraint works_body_length check (char_length(body) <= 50000),
  constraint works_id_user_id_unique unique (id, user_id)
);

create table if not exists public.work_assets (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  asset_type text not null,
  storage_path text not null unique,
  mime_type text not null,
  sort_order integer not null default 0,
  duration_seconds integer,
  created_at timestamptz not null default now(),
  constraint work_assets_work_owner_fk
    foreign key (work_id, user_id)
    references public.works (id, user_id)
    on delete cascade,
  constraint work_assets_type_allowed check (asset_type in ('image', 'video', 'audio')),
  constraint work_assets_sort_order_valid check (sort_order >= 0),
  constraint work_assets_duration_valid check (duration_seconds is null or duration_seconds between 1 and 86400),
  constraint work_assets_mime_matches_type check (
    (asset_type = 'image' and mime_type in ('image/jpeg', 'image/png', 'image/webp'))
    or (asset_type = 'video' and mime_type in ('video/mp4', 'video/webm'))
    or (asset_type = 'audio' and mime_type in ('audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/wave'))
  ),
  constraint work_assets_path_canonical check (
    storage_path ~ (
      '^' || user_id::text || '/' || work_id::text || '/' || id::text
      || case
        when asset_type = 'image' then '\.(jpg|png|webp)$'
        when asset_type = 'video' then '\.(mp4|webm)$'
        else '\.(mp3|wav)$'
      end
    )
  )
);

create index if not exists works_published_created_at_idx
  on public.works (published, created_at desc);

create index if not exists works_user_id_updated_at_idx
  on public.works (user_id, updated_at desc);

create index if not exists works_source_music_track_id_idx
  on public.works (source_music_track_id)
  where source_music_track_id is not null;

create index if not exists work_assets_work_order_idx
  on public.work_assets (work_id, sort_order, created_at, id);

create or replace function public.set_work_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_work_updated_at on public.works;
create trigger set_work_updated_at
before update on public.works
for each row execute function public.set_work_updated_at();

create or replace function public.assert_work_source_track_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.source_music_track_id is not null and not exists (
    select 1
    from public.music_tracks as track
    where track.id = new.source_music_track_id
      and track.user_id = new.user_id
  ) then
    raise exception 'source_music_track_id must belong to the work owner';
  end if;
  return new;
end;
$$;

drop trigger if exists assert_work_source_track_owner on public.works;
create trigger assert_work_source_track_owner
before insert or update of source_music_track_id, user_id on public.works
for each row execute function public.assert_work_source_track_owner();

create or replace function public.assert_work_publishable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.published and not (
    char_length(btrim(new.body)) > 0
    or new.source_music_track_id is not null
    or exists (
      select 1 from public.work_assets as asset
      where asset.work_id = new.id and asset.user_id = new.user_id
    )
  ) then
    raise exception 'a published work must contain body text, an asset, or a source music track';
  end if;
  return new;
end;
$$;

drop trigger if exists assert_work_publishable on public.works;
create trigger assert_work_publishable
before insert or update of published, body, source_music_track_id on public.works
for each row execute function public.assert_work_publishable();

revoke execute on function public.set_work_updated_at() from public, anon, authenticated;
revoke execute on function public.assert_work_source_track_owner() from public, anon, authenticated;
revoke execute on function public.assert_work_publishable() from public, anon, authenticated;

alter table public.works enable row level security;
alter table public.work_assets enable row level security;

revoke all on table public.works from anon, authenticated;
grant select on table public.works to anon, authenticated;
grant insert (user_id, title, body, source_music_track_id)
  on table public.works to authenticated;
grant update (title, body, source_music_track_id, published)
  on table public.works to authenticated;
grant delete on table public.works to authenticated;

revoke all on table public.work_assets from anon, authenticated;
grant select on table public.work_assets to anon, authenticated;
grant insert (id, work_id, user_id, asset_type, storage_path, mime_type, sort_order, duration_seconds)
  on table public.work_assets to authenticated;
grant update (sort_order) on table public.work_assets to authenticated;
grant delete on table public.work_assets to authenticated;

drop policy if exists "Published works are publicly readable" on public.works;
create policy "Published works are publicly readable"
on public.works for select
to anon
using (published = true);

drop policy if exists "Users read published or own works" on public.works;
create policy "Users read published or own works"
on public.works for select
to authenticated
using (published = true or user_id = (select auth.uid()));

drop policy if exists "Users create own works" on public.works;
create policy "Users create own works"
on public.works for insert
to authenticated
with check (user_id = (select auth.uid()) and published = false);

drop policy if exists "Users update own works" on public.works;
create policy "Users update own works"
on public.works for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists "Users delete own works" on public.works;
create policy "Users delete own works"
on public.works for delete
to authenticated
using (
  user_id = (select auth.uid())
  and published = false
  and not exists (
    select 1
    from public.work_assets as asset
    where asset.work_id = works.id
      and asset.user_id = works.user_id
  )
);

drop policy if exists "Published work assets are publicly readable" on public.work_assets;
create policy "Published work assets are publicly readable"
on public.work_assets for select
to anon
using (
  exists (
    select 1 from public.works as work
    where work.id = work_assets.work_id
      and work.user_id = work_assets.user_id
      and work.published = true
  )
);

drop policy if exists "Users read published or own work assets" on public.work_assets;
create policy "Users read published or own work assets"
on public.work_assets for select
to authenticated
using (
  exists (
    select 1 from public.works as work
    where work.id = work_assets.work_id
      and work.user_id = work_assets.user_id
      and (work.published = true or work.user_id = (select auth.uid()))
  )
);

drop policy if exists "Users create assets for own works" on public.work_assets;
create policy "Users create assets for own works"
on public.work_assets for insert
to authenticated
with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.works as work
    where work.id = work_assets.work_id
      and work.user_id = (select auth.uid())
      and work.user_id = work_assets.user_id
      and work.published = false
  )
);

drop policy if exists "Users update assets for own works" on public.work_assets;
create policy "Users update assets for own works"
on public.work_assets for update
to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.works as work
    where work.id = work_assets.work_id
      and work.user_id = (select auth.uid())
      and work.published = false
  )
)
with check (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.works as work
    where work.id = work_assets.work_id
      and work.user_id = (select auth.uid())
      and work.published = false
  )
);

drop policy if exists "Users delete assets for own works" on public.work_assets;
create policy "Users delete assets for own works"
on public.work_assets for delete
to authenticated
using (
  user_id = (select auth.uid())
  and exists (
    select 1 from public.works as work
    where work.id = work_assets.work_id
      and work.user_id = (select auth.uid())
      and work.published = false
  )
);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'work-media',
  'work-media',
  false,
  209715200,
  array[
    'image/jpeg', 'image/png', 'image/webp',
    'video/mp4', 'video/webm',
    'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/wave'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Published work media or owner can read" on storage.objects;
create policy "Published work media or owner can read"
on storage.objects for select
to anon, authenticated
using (
  bucket_id = 'work-media'
  and array_length(storage.foldername(name), 1) = 2
  and exists (
    select 1
    from public.work_assets as asset
    join public.works as work
      on work.id = asset.work_id and work.user_id = asset.user_id
    where asset.storage_path = name
      and work.id::text = (storage.foldername(name))[2]
      and work.user_id::text = (storage.foldername(name))[1]
      and (work.published = true or work.user_id = (select auth.uid()))
  )
);

drop policy if exists "Users read media in own draft work path" on storage.objects;
create policy "Users read media in own draft work path"
on storage.objects for select
to authenticated
using (
  bucket_id = 'work-media'
  and owner_id = (select auth.uid()::text)
  and array_length(storage.foldername(name), 1) = 2
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and storage.filename(name) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp|mp4|webm|mp3|wav)$'
  and exists (
    select 1 from public.works as work
    where work.id::text = (storage.foldername(name))[2]
      and work.user_id = (select auth.uid())
      and work.user_id::text = (storage.foldername(name))[1]
      and work.published = false
  )
);

drop policy if exists "Users upload media into own work path" on storage.objects;
create policy "Users upload media into own work path"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'work-media'
  and array_length(storage.foldername(name), 1) = 2
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and storage.filename(name) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp|mp4|webm|mp3|wav)$'
  and exists (
    select 1 from public.works as work
    where work.id::text = (storage.foldername(name))[2]
      and work.user_id = (select auth.uid())
      and work.user_id::text = (storage.foldername(name))[1]
      and work.published = false
  )
);

drop policy if exists "Users update media in own work path" on storage.objects;
create policy "Users update media in own work path"
on storage.objects for update
to authenticated
using (
  bucket_id = 'work-media'
  and owner_id = (select auth.uid()::text)
  and array_length(storage.foldername(name), 1) = 2
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and exists (
    select 1 from public.works as work
    where work.id::text = (storage.foldername(name))[2]
      and work.user_id = (select auth.uid())
      and work.published = false
  )
)
with check (
  bucket_id = 'work-media'
  and owner_id = (select auth.uid()::text)
  and array_length(storage.foldername(name), 1) = 2
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and storage.filename(name) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp|mp4|webm|mp3|wav)$'
  and exists (
    select 1 from public.works as work
    where work.id::text = (storage.foldername(name))[2]
      and work.user_id = (select auth.uid())
      and work.published = false
  )
);

drop policy if exists "Users delete media from own work path" on storage.objects;
create policy "Users delete media from own work path"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'work-media'
  and owner_id = (select auth.uid()::text)
  and array_length(storage.foldername(name), 1) = 2
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and exists (
    select 1 from public.works as work
    where work.id::text = (storage.foldername(name))[2]
      and work.user_id = (select auth.uid())
      and work.published = false
  )
);

commit;
