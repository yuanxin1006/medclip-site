-- MedClip C3A local-only public release safety foundation.
-- Do not apply remotely until the separate C3A deployment phase is authorized.

begin;

alter table medclip_private.music_generation_operations
  add column if not exists provider_dispatched_at timestamptz;

-- Preserve historical paid-attempt evidence. Existing rows predate the
-- dedicated dispatch timestamp, so created_at is the safest durable fallback.
update medclip_private.music_generation_operations
set provider_dispatched_at = created_at
where provider_call_count = 1
  and provider_dispatched_at is null;

alter table medclip_private.music_generation_operations
  drop constraint if exists music_generation_operations_dispatch_timestamp_safe;
alter table medclip_private.music_generation_operations
  add constraint music_generation_operations_dispatch_timestamp_safe
  check (provider_dispatched_at is null or provider_call_count = 1);

create index if not exists music_generation_operations_dispatch_day_idx
  on medclip_private.music_generation_operations (provider_dispatched_at)
  where provider_dispatched_at is not null;

create index if not exists music_generation_operations_user_dispatch_day_idx
  on medclip_private.music_generation_operations (user_id, provider_dispatched_at)
  where provider_dispatched_at is not null;

create or replace function public.medclip_reserve_music_generation_operation_guarded(
  target_user_id uuid,
  target_operation_id text,
  target_task text,
  target_provider text,
  target_request_hash text,
  target_counts_paid_dispatch boolean,
  target_enforce_user_daily_limit boolean,
  target_user_daily_limit integer,
  target_global_daily_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing medclip_private.music_generation_operations;
  quota_start timestamptz;
  quota_end timestamptz;
  usage_count bigint;
begin
  if target_user_daily_limit < 1 or target_user_daily_limit > 100000
    or target_global_daily_limit < 1 or target_global_daily_limit > 100000 then
    raise exception 'INVALID_MUSIC_QUOTA_CONFIGURATION' using errcode = 'P0001';
  end if;

  quota_start := pg_catalog.date_trunc('day', pg_catalog.statement_timestamp() at time zone 'UTC') at time zone 'UTC';
  quota_end := quota_start + interval '1 day';

  -- Global lock is always taken before the user lock to avoid lock inversion.
  if target_counts_paid_dispatch then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('medclip:music:global:' || quota_start::text, 0)
    );
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('medclip:music:user:' || target_user_id::text, 0)
  );

  select operation.* into existing
  from medclip_private.music_generation_operations as operation
  where operation.user_id = target_user_id
    and operation.operation_id = target_operation_id
  for update;

  if existing.id is not null then
    if existing.task <> target_task
      or existing.provider <> target_provider
      or existing.request_hash <> target_request_hash then
      raise exception 'OPERATION_CONFLICT' using errcode = 'P0001';
    end if;
    return to_jsonb(existing) || jsonb_build_object('created', false);
  end if;

  if exists (
    select 1
    from medclip_private.music_generation_operations as operation
    where operation.user_id = target_user_id
      and operation.state in ('RESERVED', 'PROVIDER_IN_FLIGHT', 'FINALIZING', 'UNKNOWN')
  ) then
    raise exception 'MUSIC_GENERATION_ALREADY_ACTIVE' using errcode = 'P0001';
  end if;

  if target_counts_paid_dispatch then
    if target_enforce_user_daily_limit then
      select count(*) into usage_count
      from medclip_private.music_generation_operations as operation
      where operation.user_id = target_user_id
        and operation.provider_dispatched_at >= quota_start
        and operation.provider_dispatched_at < quota_end;
      if usage_count >= target_user_daily_limit then
        raise exception 'MUSIC_DAILY_LIMIT_REACHED' using errcode = 'P0001';
      end if;
    end if;

    select count(*) into usage_count
    from medclip_private.music_generation_operations as operation
    where operation.provider_dispatched_at >= quota_start
      and operation.provider_dispatched_at < quota_end;
    if usage_count >= target_global_daily_limit then
      raise exception 'MUSIC_GLOBAL_LIMIT_REACHED' using errcode = 'P0001';
    end if;
  end if;

  insert into medclip_private.music_generation_operations (
    user_id, operation_id, task, provider, request_hash
  ) values (
    target_user_id, target_operation_id, target_task, target_provider, target_request_hash
  ) returning * into existing;

  return to_jsonb(existing) || jsonb_build_object('created', true);
end;
$$;

create or replace function public.medclip_authorize_music_provider_dispatch(
  target_user_id uuid,
  target_operation_id text,
  target_counts_paid_dispatch boolean,
  target_enforce_user_daily_limit boolean,
  target_user_daily_limit integer,
  target_global_daily_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_operation medclip_private.music_generation_operations;
  transitioned medclip_private.music_generation_operations;
  quota_start timestamptz;
  quota_end timestamptz;
  usage_count bigint;
begin
  if target_user_daily_limit < 1 or target_user_daily_limit > 100000
    or target_global_daily_limit < 1 or target_global_daily_limit > 100000 then
    raise exception 'INVALID_MUSIC_QUOTA_CONFIGURATION' using errcode = 'P0001';
  end if;

  quota_start := pg_catalog.date_trunc('day', pg_catalog.statement_timestamp() at time zone 'UTC') at time zone 'UTC';
  quota_end := quota_start + interval '1 day';

  if target_counts_paid_dispatch then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('medclip:music:global:' || quota_start::text, 0)
    );
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('medclip:music:user:' || target_user_id::text, 0)
  );

  select operation.* into current_operation
  from medclip_private.music_generation_operations as operation
  where operation.user_id = target_user_id
    and operation.operation_id = target_operation_id
  for update;

  if current_operation.id is null
    or current_operation.state <> 'RESERVED'
    or current_operation.provider_call_count <> 0 then
    raise exception 'OPERATION_TRANSITION_CONFLICT' using errcode = 'P0001';
  end if;

  if target_counts_paid_dispatch then
    if target_enforce_user_daily_limit then
      select count(*) into usage_count
      from medclip_private.music_generation_operations as operation
      where operation.user_id = target_user_id
        and operation.provider_dispatched_at >= quota_start
        and operation.provider_dispatched_at < quota_end;
      if usage_count >= target_user_daily_limit then
        raise exception 'MUSIC_DAILY_LIMIT_REACHED' using errcode = 'P0001';
      end if;
    end if;

    select count(*) into usage_count
    from medclip_private.music_generation_operations as operation
    where operation.provider_dispatched_at >= quota_start
      and operation.provider_dispatched_at < quota_end;
    if usage_count >= target_global_daily_limit then
      raise exception 'MUSIC_GLOBAL_LIMIT_REACHED' using errcode = 'P0001';
    end if;
  end if;

  update medclip_private.music_generation_operations as operation
  set
    state = 'PROVIDER_IN_FLIGHT',
    provider_call_count = 1,
    provider_dispatched_at = case
      when target_counts_paid_dispatch then pg_catalog.statement_timestamp()
      else null
    end
  where operation.id = current_operation.id
    and operation.state = 'RESERVED'
    and operation.provider_call_count = 0
  returning operation.* into transitioned;

  if transitioned.id is null then
    raise exception 'OPERATION_TRANSITION_CONFLICT' using errcode = 'P0001';
  end if;
  return to_jsonb(transitioned);
end;
$$;

revoke execute on function public.medclip_reserve_music_generation_operation_guarded(
  uuid, text, text, text, text, boolean, boolean, integer, integer
) from public, anon, authenticated;
revoke execute on function public.medclip_authorize_music_provider_dispatch(
  uuid, text, boolean, boolean, integer, integer
) from public, anon, authenticated;
grant execute on function public.medclip_reserve_music_generation_operation_guarded(
  uuid, text, text, text, text, boolean, boolean, integer, integer
) to service_role;
grant execute on function public.medclip_authorize_music_provider_dispatch(
  uuid, text, boolean, boolean, integer, integer
) to service_role;

-- The legacy transition RPC remains valid for post-dispatch settlement only.
-- RESERVED -> PROVIDER_IN_FLIGHT is exclusively authorized by the quota gate.
create or replace function public.medclip_transition_music_generation_operation(
  target_user_id uuid,
  target_operation_id text,
  expected_state text,
  next_state text,
  next_provider_call_count smallint,
  next_provider_request_id text default null,
  next_provider_trace_id text default null,
  next_final_track_id uuid default null,
  next_failure_code text default null,
  next_failure_diagnostics jsonb default null
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
    (expected_state = 'RESERVED' and next_state = 'FAILED' and next_provider_call_count = 0)
    or (expected_state = 'PROVIDER_IN_FLIGHT' and next_state in ('FINALIZING', 'FAILED', 'UNKNOWN') and next_provider_call_count = 1)
    or (expected_state = 'FINALIZING' and next_state in ('COMPLETED', 'FAILED', 'UNKNOWN') and next_provider_call_count = 1)
  ) then
    raise exception 'INVALID_OPERATION_TRANSITION' using errcode = 'P0001';
  end if;
  if next_state not in ('FAILED', 'UNKNOWN') and next_failure_diagnostics is not null then
    raise exception 'INVALID_FAILURE_DIAGNOSTICS_STATE' using errcode = 'P0001';
  end if;
  if not medclip_private.is_valid_music_failure_diagnostics(next_failure_diagnostics) then
    raise exception 'INVALID_FAILURE_DIAGNOSTICS' using errcode = 'P0001';
  end if;

  update medclip_private.music_generation_operations as operation
  set
    state = next_state,
    provider_call_count = next_provider_call_count,
    provider_request_id = coalesce(next_provider_request_id, operation.provider_request_id),
    provider_trace_id = coalesce(next_provider_trace_id, operation.provider_trace_id),
    final_track_id = next_final_track_id,
    failure_code = next_failure_code,
    failure_diagnostics = case
      when next_state in ('FAILED', 'UNKNOWN') then next_failure_diagnostics
      else null
    end
  where operation.user_id = target_user_id
    and operation.operation_id = target_operation_id
    and operation.state = expected_state
    and operation.provider_call_count <= 1
  returning operation.* into transitioned;

  if transitioned.id is null then
    raise exception 'OPERATION_TRANSITION_CONFLICT' using errcode = 'P0001';
  end if;
  return to_jsonb(transitioned);
end;
$$;

revoke execute on function public.medclip_transition_music_generation_operation(
  uuid, text, text, text, smallint, text, text, uuid, text, jsonb
) from public, anon, authenticated;
grant execute on function public.medclip_transition_music_generation_operation(
  uuid, text, text, text, smallint, text, text, uuid, text, jsonb
) to service_role;

commit;
