-- MedClip music platform canonical initial migration.
-- Review and run manually in the Supabase SQL Editor as a project owner.
-- This file has not been executed against a real Supabase project by Codex.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  avatar_url text,
  created_at timestamptz not null default now(),
  constraint profiles_display_name_length check (char_length(display_name) <= 100)
);

create table if not exists public.music_tracks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  artist_name text not null,
  description text not null default '',
  genre text,
  cover_path text,
  audio_path text,
  duration_seconds integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published boolean not null default false,
  constraint music_tracks_title_not_blank
    check (char_length(btrim(title)) between 1 and 200),
  constraint music_tracks_artist_not_blank
    check (char_length(btrim(artist_name)) between 1 and 120),
  constraint music_tracks_description_length
    check (char_length(description) <= 5000),
  constraint music_tracks_genre_length
    check (genre is null or char_length(genre) <= 100),
  constraint music_tracks_duration_valid
    check (duration_seconds is null or duration_seconds between 1 and 86400),
  constraint music_tracks_audio_path_canonical
    check (
      audio_path is null
      or audio_path ~ (
        '^' || user_id::text || '/' || id::text || '/audio\.(mp3|wav)$'
      )
    ),
  constraint music_tracks_cover_path_canonical
    check (
      cover_path is null
      or cover_path ~ (
        '^' || user_id::text || '/' || id::text || '/cover\.(jpg|png|webp)$'
      )
    ),
  constraint music_tracks_publishable
    check (
      not published
      or (
        audio_path is not null
        and duration_seconds is not null
        and duration_seconds > 0
      )
    )
);

create index if not exists music_tracks_published_created_at_idx
  on public.music_tracks (published, created_at desc);

create index if not exists music_tracks_user_id_created_at_idx
  on public.music_tracks (user_id, created_at desc);

create or replace function public.set_music_track_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_music_track_updated_at on public.music_tracks;
create trigger set_music_track_updated_at
before update on public.music_tracks
for each row execute function public.set_music_track_updated_at();

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    left(
      coalesce(
        nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
        nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
        nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
        'New creator'
      ),
      100
    ),
    nullif(btrim(new.raw_user_meta_data ->> 'avatar_url'), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_create_profile on auth.users;
create trigger on_auth_user_created_create_profile
after insert on auth.users
for each row execute function public.handle_new_user_profile();

-- Trigger invocation does not require API roles to have direct EXECUTE access.
revoke execute on function public.handle_new_user_profile() from public;
revoke execute on function public.handle_new_user_profile() from anon, authenticated;
revoke execute on function public.set_music_track_updated_at() from public;
revoke execute on function public.set_music_track_updated_at() from anon, authenticated;

alter table public.profiles enable row level security;
alter table public.music_tracks enable row level security;

revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to anon, authenticated;
grant update (display_name, avatar_url) on table public.profiles to authenticated;

revoke all on table public.music_tracks from anon, authenticated;
grant select on table public.music_tracks to anon, authenticated;
grant insert (
  user_id, title, artist_name, description, genre, cover_path,
  audio_path, duration_seconds, published
) on table public.music_tracks to authenticated;
grant update (
  title, artist_name, description, genre, cover_path,
  audio_path, duration_seconds, published
) on table public.music_tracks to authenticated;
grant delete on table public.music_tracks to authenticated;

drop policy if exists "Public profiles are readable" on public.profiles;
create policy "Public profiles are readable"
on public.profiles for select
to anon, authenticated
using (true);

drop policy if exists "Users update their own profile" on public.profiles;
create policy "Users update their own profile"
on public.profiles for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

drop policy if exists "Published tracks are publicly readable" on public.music_tracks;
create policy "Published tracks are publicly readable"
on public.music_tracks for select
to anon
using (published = true);

drop policy if exists "Users read published or own tracks" on public.music_tracks;
create policy "Users read published or own tracks"
on public.music_tracks for select
to authenticated
using (published = true or (select auth.uid()) = user_id);

drop policy if exists "Users create their own tracks" on public.music_tracks;
create policy "Users create their own tracks"
on public.music_tracks for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users update their own tracks" on public.music_tracks;
create policy "Users update their own tracks"
on public.music_tracks for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users delete their own tracks" on public.music_tracks;
create policy "Users delete their own tracks"
on public.music_tracks for delete
to authenticated
using ((select auth.uid()) = user_id);

-- Private buckets keep every object behind Storage RLS, including known paths.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  (
    'music-audio',
    'music-audio',
    false,
    104857600,
    array['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/wave']
  ),
  (
    'music-covers',
    'music-covers',
    false,
    10485760,
    array['image/jpeg', 'image/png', 'image/webp']
  )
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Resolve every object through userId/trackId/filename without casting user input.
drop policy if exists "Published track media or owner can read" on storage.objects;
create policy "Published track media or owner can read"
on storage.objects for select
to anon, authenticated
using (
  bucket_id in ('music-audio', 'music-covers')
  and array_length(storage.foldername(name), 1) = 2
  and exists (
    select 1
    from public.music_tracks as track
    where track.id::text = (storage.foldername(name))[2]
      and track.user_id::text = (storage.foldername(name))[1]
      and (
        track.published = true
        or track.user_id = (select auth.uid())
      )
  )
);

drop policy if exists "Users upload media for their own track" on storage.objects;
create policy "Users upload media for their own track"
on storage.objects for insert
to authenticated
with check (
  bucket_id in ('music-audio', 'music-covers')
  and array_length(storage.foldername(name), 1) = 2
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and (
    (bucket_id = 'music-audio' and storage.filename(name) ~ '^audio\.(mp3|wav)$')
    or (bucket_id = 'music-covers' and storage.filename(name) ~ '^cover\.(jpg|png|webp)$')
  )
  and exists (
    select 1
    from public.music_tracks as track
    where track.id::text = (storage.foldername(name))[2]
      and track.user_id = (select auth.uid())
      and track.user_id::text = (storage.foldername(name))[1]
  )
);

drop policy if exists "Users update media for their own track" on storage.objects;
create policy "Users update media for their own track"
on storage.objects for update
to authenticated
using (
  bucket_id in ('music-audio', 'music-covers')
  and owner_id = (select auth.uid()::text)
  and array_length(storage.foldername(name), 1) = 2
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and exists (
    select 1
    from public.music_tracks as track
    where track.id::text = (storage.foldername(name))[2]
      and track.user_id = (select auth.uid())
      and track.user_id::text = (storage.foldername(name))[1]
  )
)
with check (
  bucket_id in ('music-audio', 'music-covers')
  and owner_id = (select auth.uid()::text)
  and array_length(storage.foldername(name), 1) = 2
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and (
    (bucket_id = 'music-audio' and storage.filename(name) ~ '^audio\.(mp3|wav)$')
    or (bucket_id = 'music-covers' and storage.filename(name) ~ '^cover\.(jpg|png|webp)$')
  )
  and exists (
    select 1
    from public.music_tracks as track
    where track.id::text = (storage.foldername(name))[2]
      and track.user_id = (select auth.uid())
      and track.user_id::text = (storage.foldername(name))[1]
  )
);

drop policy if exists "Users delete media for their own track" on storage.objects;
create policy "Users delete media for their own track"
on storage.objects for delete
to authenticated
using (
  bucket_id in ('music-audio', 'music-covers')
  and owner_id = (select auth.uid()::text)
  and array_length(storage.foldername(name), 1) = 2
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and exists (
    select 1
    from public.music_tracks as track
    where track.id::text = (storage.foldername(name))[2]
      and track.user_id = (select auth.uid())
      and track.user_id::text = (storage.foldername(name))[1]
  )
);
