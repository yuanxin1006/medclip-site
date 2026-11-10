-- MedClip server-only durable ledger for paid music generation operations.
-- C1C1 creates this migration locally only; do not apply it remotely yet.

begin;

create schema if not exists medclip_private;
revoke all on schema medclip_private from public, anon, authenticated;

create table if not exists medclip_private.music_generation_operations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  operation_id text not null,
  task text not null,
  provider text not null,
  request_hash text not null,
  state text not null default 'RESERVED',
  provider_call_count smallint not null default 0,
  provider_request_id text,
  provider_trace_id text,
  final_track_id uuid references public.music_tracks (id) on delete set null,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint music_generation_operations_owner_operation_unique
    unique (user_id, operation_id),
  constraint music_generation_operations_operation_id_safe
    check (operation_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$'),
  constraint music_generation_operations_task_fixed
    check (task = 'music.generate'),
  constraint music_generation_operations_provider_fixed
    check (provider = 'tencent_tokenhub'),
  constraint music_generation_operations_request_hash_safe
    check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint music_generation_operations_state_safe
    check (state in ('RESERVED', 'PROVIDER_IN_FLIGHT', 'FINALIZING', 'COMPLETED', 'FAILED', 'UNKNOWN')),
  constraint music_generation_operations_provider_call_count_safe
    check (provider_call_count between 0 and 1),
  constraint music_generation_operations_provider_request_id_safe
    check (
      provider_request_id is null
      or provider_request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
  constraint music_generation_operations_provider_trace_id_safe
    check (
      provider_trace_id is null
      or provider_trace_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
  constraint music_generation_operations_failure_code_safe
    check (failure_code is null or failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  constraint music_generation_operations_state_data_consistent
    check (
      (state = 'RESERVED' and provider_call_count = 0 and final_track_id is null and failure_code is null)
      or (state = 'PROVIDER_IN_FLIGHT' and provider_call_count = 1 and final_track_id is null and failure_code is null)
      or (state = 'FINALIZING' and provider_call_count = 1 and final_track_id is null and failure_code is null)
      or (state = 'COMPLETED' and provider_call_count = 1 and final_track_id is not null and failure_code is null)
      or (state = 'FAILED' and provider_call_count between 0 and 1 and final_track_id is null and failure_code is not null)
      or (state = 'UNKNOWN' and provider_call_count = 1 and final_track_id is null and failure_code is not null)
    )
);

create index if not exists music_generation_operations_user_updated_idx
  on medclip_private.music_generation_operations (user_id, updated_at desc);

alter table medclip_private.music_generation_operations enable row level security;
revoke all on table medclip_private.music_generation_operations from public, anon, authenticated;
grant select, insert, update on table medclip_private.music_generation_operations to service_role;

create or replace function medclip_private.set_music_generation_operation_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_music_generation_operation_updated_at
  on medclip_private.music_generation_operations;
create trigger set_music_generation_operation_updated_at
before update on medclip_private.music_generation_operations
for each row execute function medclip_private.set_music_generation_operation_updated_at();

revoke execute on function medclip_private.set_music_generation_operation_updated_at()
  from public, anon, authenticated;

create or replace function public.medclip_reserve_music_generation_operation(
  target_user_id uuid,
  target_operation_id text,
  target_task text,
  target_provider text,
  target_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing medclip_private.music_generation_operations;
  created_now boolean := false;
begin
  insert into medclip_private.music_generation_operations (
    user_id,
    operation_id,
    task,
    provider,
    request_hash
  ) values (
    target_user_id,
    target_operation_id,
    target_task,
    target_provider,
    target_request_hash
  )
  on conflict (user_id, operation_id) do nothing;

  created_now := found;

  select operation.*
  into existing
  from medclip_private.music_generation_operations as operation
  where operation.user_id = target_user_id
    and operation.operation_id = target_operation_id
  for update;

  if existing.id is null then
    raise exception 'OPERATION_RESERVATION_FAILED' using errcode = 'P0001';
  end if;

  if existing.task <> target_task
    or existing.provider <> target_provider
    or existing.request_hash <> target_request_hash then
    raise exception 'OPERATION_CONFLICT' using errcode = 'P0001';
  end if;

  return to_jsonb(existing) || jsonb_build_object('created', created_now);
end;
$$;

create or replace function public.medclip_get_music_generation_operation(
  target_user_id uuid,
  target_operation_id text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select to_jsonb(operation)
  from medclip_private.music_generation_operations as operation
  where operation.user_id = target_user_id
    and operation.operation_id = target_operation_id;
$$;

create or replace function public.medclip_transition_music_generation_operation(
  target_user_id uuid,
  target_operation_id text,
  expected_state text,
  next_state text,
  next_provider_call_count smallint,
  next_provider_request_id text default null,
  next_provider_trace_id text default null,
  next_final_track_id uuid default null,
  next_failure_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  transitioned medclip_private.music_generation_operations;
begin
  if not (
    (expected_state = 'RESERVED' and next_state = 'PROVIDER_IN_FLIGHT' and next_provider_call_count = 1)
    or (expected_state = 'RESERVED' and next_state = 'FAILED' and next_provider_call_count = 0)
    or (expected_state = 'PROVIDER_IN_FLIGHT' and next_state in ('FINALIZING', 'FAILED', 'UNKNOWN') and next_provider_call_count = 1)
    or (expected_state = 'FINALIZING' and next_state in ('COMPLETED', 'FAILED', 'UNKNOWN') and next_provider_call_count = 1)
  ) then
    raise exception 'INVALID_OPERATION_TRANSITION' using errcode = 'P0001';
  end if;

  update medclip_private.music_generation_operations as operation
  set
    state = next_state,
    provider_call_count = next_provider_call_count,
    provider_request_id = coalesce(next_provider_request_id, operation.provider_request_id),
    provider_trace_id = coalesce(next_provider_trace_id, operation.provider_trace_id),
    final_track_id = next_final_track_id,
    failure_code = next_failure_code
  where operation.user_id = target_user_id
    and operation.operation_id = target_operation_id
    and operation.state = expected_state
    and operation.provider_call_count <= 1
    and (
      expected_state <> 'RESERVED'
      or next_state <> 'PROVIDER_IN_FLIGHT'
      or (operation.provider_call_count = 0 and next_provider_call_count = 1)
    )
  returning operation.* into transitioned;

  if transitioned.id is null then
    raise exception 'OPERATION_TRANSITION_CONFLICT' using errcode = 'P0001';
  end if;

  return to_jsonb(transitioned);
end;
$$;

revoke execute on function public.medclip_reserve_music_generation_operation(
  uuid, text, text, text, text
) from public, anon, authenticated;
revoke execute on function public.medclip_get_music_generation_operation(
  uuid, text
) from public, anon, authenticated;
revoke execute on function public.medclip_transition_music_generation_operation(
  uuid, text, text, text, smallint, text, text, uuid, text
) from public, anon, authenticated;

grant execute on function public.medclip_reserve_music_generation_operation(
  uuid, text, text, text, text
) to service_role;
grant execute on function public.medclip_get_music_generation_operation(
  uuid, text
) to service_role;
grant execute on function public.medclip_transition_music_generation_operation(
  uuid, text, text, text, smallint, text, text, uuid, text
) to service_role;

commit;
