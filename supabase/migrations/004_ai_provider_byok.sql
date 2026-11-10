begin;

-- Browser-readable metadata contains no API key, ciphertext, IV, or server secret.
create table public.user_ai_provider_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null,
  provider_resource_id text,
  key_last4 text not null,
  status text not null default 'connected',
  last_validated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_ai_provider_connections_provider_allowed
    check (provider in ('deepseek', 'doubao', 'kimi', 'openai', 'gemini')),
  constraint user_ai_provider_connections_last4_safe
    check (key_last4 ~ '^[^[:space:][:cntrl:]]{4}$'),
  constraint user_ai_provider_connections_status_allowed
    check (status in ('connected', 'validation_failed', 'needs_update')),
  constraint user_ai_provider_connections_resource_safe
    check (
      (
        provider = 'doubao'
        and provider_resource_id is not null
        and provider_resource_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$'
      )
      or
      (
        provider <> 'doubao'
        and provider_resource_id is null
      )
    ),
  constraint user_ai_provider_connections_user_provider_unique unique (user_id, provider),
  constraint user_ai_provider_connections_identity_unique unique (id, user_id, provider)
);

create index user_ai_provider_connections_user_id_idx
  on public.user_ai_provider_connections (user_id, created_at);

-- 003 already created this schema and granted the minimum usage required by
-- the existing works-delete RLS helper. Do not revoke or alter that grant here.
create schema if not exists medclip_private;

create table medclip_private.user_ai_credentials (
  connection_id uuid primary key,
  user_id uuid not null,
  provider text not null,
  ciphertext text not null,
  iv text not null,
  encryption_version smallint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_ai_credentials_connection_fk
    foreign key (connection_id, user_id, provider)
    references public.user_ai_provider_connections (id, user_id, provider)
    on delete cascade,
  constraint user_ai_credentials_user_provider_unique unique (user_id, provider),
  constraint user_ai_credentials_provider_allowed
    check (provider in ('deepseek', 'doubao', 'kimi', 'openai', 'gemini')),
  constraint user_ai_credentials_ciphertext_present check (char_length(ciphertext) >= 24),
  constraint user_ai_credentials_iv_present check (char_length(iv) >= 16),
  constraint user_ai_credentials_encryption_version check (encryption_version = 1)
);

alter table public.user_ai_provider_connections enable row level security;
alter table medclip_private.user_ai_credentials enable row level security;

revoke all on table public.user_ai_provider_connections from public, anon, authenticated;
grant select on table public.user_ai_provider_connections to authenticated;
grant select, update on table public.user_ai_provider_connections to service_role;

revoke all on table medclip_private.user_ai_credentials from public, anon, authenticated;

drop policy if exists "Users read own AI provider metadata" on public.user_ai_provider_connections;
create policy "Users read own AI provider metadata"
on public.user_ai_provider_connections for select
to authenticated
using (user_id = (select auth.uid()));

create or replace function medclip_private.set_ai_provider_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger set_user_ai_provider_connections_updated_at
before update on public.user_ai_provider_connections
for each row execute function medclip_private.set_ai_provider_updated_at();

create trigger set_user_ai_credentials_updated_at
before update on medclip_private.user_ai_credentials
for each row execute function medclip_private.set_ai_provider_updated_at();

revoke execute on function medclip_private.set_ai_provider_updated_at()
  from public, anon, authenticated;

-- Atomic server-only save/update. The caller is the authenticated Edge
-- Function after it derives target_user_id from a verified Supabase JWT.
create or replace function public.medclip_upsert_ai_provider_credential(
  target_user_id uuid,
  target_provider text,
  target_provider_resource_id text,
  target_key_last4 text,
  target_ciphertext text,
  target_iv text,
  target_encryption_version smallint,
  target_validated_at timestamptz
)
returns public.user_ai_provider_connections
language plpgsql
security definer
set search_path = ''
as $$
declare
  connection public.user_ai_provider_connections;
begin
  insert into public.user_ai_provider_connections (
    user_id,
    provider,
    provider_resource_id,
    key_last4,
    status,
    last_validated_at
  ) values (
    target_user_id,
    target_provider,
    target_provider_resource_id,
    target_key_last4,
    'connected',
    target_validated_at
  )
  on conflict (user_id, provider) do update set
    provider_resource_id = excluded.provider_resource_id,
    key_last4 = excluded.key_last4,
    status = 'connected',
    last_validated_at = excluded.last_validated_at
  returning * into connection;

  insert into medclip_private.user_ai_credentials (
    connection_id,
    user_id,
    provider,
    ciphertext,
    iv,
    encryption_version
  ) values (
    connection.id,
    connection.user_id,
    connection.provider,
    target_ciphertext,
    target_iv,
    target_encryption_version
  )
  on conflict (user_id, provider) do update set
    connection_id = excluded.connection_id,
    ciphertext = excluded.ciphertext,
    iv = excluded.iv,
    encryption_version = excluded.encryption_version;

  return connection;
end;
$$;

-- Server-only credential retrieval. The function never grants browser roles
-- access and is used only to decrypt a saved credential inside the Edge Function.
create or replace function public.medclip_get_ai_provider_credential(
  target_user_id uuid,
  target_provider text
)
returns table (
  provider text,
  provider_resource_id text,
  ciphertext text,
  iv text,
  encryption_version smallint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    metadata.provider,
    metadata.provider_resource_id,
    secret.ciphertext,
    secret.iv,
    secret.encryption_version
  from public.user_ai_provider_connections as metadata
  join medclip_private.user_ai_credentials as secret
    on secret.connection_id = metadata.id
    and secret.user_id = metadata.user_id
    and secret.provider = metadata.provider
  where metadata.user_id = target_user_id
    and metadata.provider = target_provider;
$$;

-- Secret and metadata deletion occur in one database transaction. The explicit
-- secret-first order also makes the intended cleanup invariant reviewable.
create or replace function public.medclip_delete_ai_provider_credential(
  target_user_id uuid,
  target_provider text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  secret_count integer;
  metadata_count integer;
begin
  delete from medclip_private.user_ai_credentials
  where user_id = target_user_id and provider = target_provider;
  get diagnostics secret_count = row_count;

  delete from public.user_ai_provider_connections
  where user_id = target_user_id and provider = target_provider;
  get diagnostics metadata_count = row_count;

  return secret_count > 0 or metadata_count > 0;
end;
$$;

revoke execute on function public.medclip_upsert_ai_provider_credential(
  uuid, text, text, text, text, text, smallint, timestamptz
) from public, anon, authenticated;
revoke execute on function public.medclip_get_ai_provider_credential(uuid, text)
  from public, anon, authenticated;
revoke execute on function public.medclip_delete_ai_provider_credential(uuid, text)
  from public, anon, authenticated;

grant execute on function public.medclip_upsert_ai_provider_credential(
  uuid, text, text, text, text, text, smallint, timestamptz
) to service_role;
grant execute on function public.medclip_get_ai_provider_credential(uuid, text)
  to service_role;
grant execute on function public.medclip_delete_ai_provider_credential(uuid, text)
  to service_role;

commit;
