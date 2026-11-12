-- MedClip music platform security contract.
-- Prerequisite: apply supabase/migrations/001_music_platform.sql to a disposable
-- local/test Supabase database. Never use service_role to prove RLS behavior.
-- This script performs schema/policy assertions and documents the two-user API
-- matrix that must be exercised with real anon/authenticated JWTs.

begin;

do $$
begin
  if not exists (
    select 1 from pg_class as table_class
    join pg_namespace as namespace on namespace.oid = table_class.relnamespace
    where namespace.nspname = 'public'
      and table_class.relname = 'profiles'
      and table_class.relrowsecurity
  ) then
    raise exception 'profiles must exist with RLS enabled';
  end if;

  if not exists (
    select 1 from pg_class as table_class
    join pg_namespace as namespace on namespace.oid = table_class.relnamespace
    where namespace.nspname = 'public'
      and table_class.relname = 'music_tracks'
      and table_class.relrowsecurity
  ) then
    raise exception 'music_tracks must exist with RLS enabled';
  end if;
end;
$$;

do $$
begin
  if not has_table_privilege('anon', 'public.music_tracks', 'SELECT') then
    raise exception 'anon must have SELECT grant on music_tracks';
  end if;

  if has_table_privilege('anon', 'public.music_tracks', 'INSERT')
    or has_table_privilege('anon', 'public.music_tracks', 'UPDATE')
    or has_table_privilege('anon', 'public.music_tracks', 'DELETE') then
    raise exception 'anon must not have music_tracks write grants';
  end if;

  if not has_table_privilege('authenticated', 'public.music_tracks', 'SELECT')
    or not has_column_privilege('authenticated', 'public.music_tracks', 'title', 'INSERT')
    or not has_column_privilege('authenticated', 'public.music_tracks', 'title', 'UPDATE')
    or not has_table_privilege('authenticated', 'public.music_tracks', 'DELETE') then
    raise exception 'authenticated role is missing required music_tracks grants';
  end if;

  if has_column_privilege('authenticated', 'public.music_tracks', 'user_id', 'UPDATE') then
    raise exception 'user_id must not be client-transferable';
  end if;
end;
$$;

do $$
begin
  if exists (
    select 1
    from storage.buckets
    where id in ('music-audio', 'music-covers')
      and public = true
  ) then
    raise exception 'music buckets must be private';
  end if;

  if (select count(*) from storage.buckets where id in ('music-audio', 'music-covers')) <> 2 then
    raise exception 'both music storage buckets must exist';
  end if;
end;
$$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'music_tracks'
      and column_name in ('audio_url', 'cover_url')
  ) then
    raise exception 'legacy media URL columns must not exist';
  end if;

  if (
    select count(*)
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'music_tracks'
      and column_name in ('audio_path', 'cover_path')
  ) <> 2 then
    raise exception 'canonical media path columns are missing';
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'music_tracks'
      and policyname = 'Published tracks are publicly readable'
      and roles = array['anon']::name[]
  ) then
    raise exception 'anonymous published-track SELECT policy is missing';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'music_tracks'
      and policyname = 'Users read published or own tracks'
  ) then
    raise exception 'authenticated track SELECT policy is missing';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Published track media or owner can read'
      and qual ilike '%music_tracks%'
      and qual ilike '%published%'
  ) then
    raise exception 'track-bound private media SELECT policy is missing';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'Users upload media for their own track'
      and with_check ilike '%music_tracks%'
  ) then
    raise exception 'track-bound media INSERT policy is missing';
  end if;
end;
$$;

do $$
begin
  if has_function_privilege('anon', 'public.handle_new_user_profile()', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.handle_new_user_profile()', 'EXECUTE') then
    raise exception 'API roles must not execute handle_new_user_profile directly';
  end if;

  if has_function_privilege('anon', 'public.set_music_track_updated_at()', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.set_music_track_updated_at()', 'EXECUTE') then
    raise exception 'API roles must not execute set_music_track_updated_at directly';
  end if;
end;
$$;

-- Expected runtime matrix. Exercise these cases through Supabase JS using an
-- anon client, a User A session, and a User B session. Storage upload/update/
-- delete must go through the Storage API so owner_id is populated normally.
select *
from (
  values
    ('USER A', 'create own track', 'ALLOW'),
    ('USER A', 'read own draft track', 'ALLOW'),
    ('USER A', 'update own track', 'ALLOW'),
    ('USER A', 'delete own track', 'ALLOW'),
    ('USER A', 'upload into own valid track path', 'ALLOW'),
    ('USER A', 'read own draft media with signed URL', 'ALLOW'),
    ('USER B', 'update User A track', 'DENY'),
    ('USER B', 'delete User A track', 'DENY'),
    ('USER B', 'upload into User A path', 'DENY'),
    ('USER B', 'update or delete User A media', 'DENY'),
    ('USER B', 'read User A draft media', 'DENY'),
    ('USER B', 'read User A published media with signed URL', 'ALLOW'),
    ('ANONYMOUS', 'create, update, or delete tracks', 'DENY'),
    ('ANONYMOUS', 'upload, update, or delete media', 'DENY'),
    ('ANONYMOUS', 'read draft tracks', 'DENY'),
    ('ANONYMOUS', 'read draft media', 'DENY'),
    ('ANONYMOUS', 'read published tracks', 'ALLOW'),
    ('ANONYMOUS', 'read published media with signed URL', 'ALLOW')
) as expected_security_matrix(actor, operation, expected_result)
order by actor, operation;

rollback;
