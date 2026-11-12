-- MedClip service-only structured diagnostics for failed music operations.
-- This migration is intentionally additive: historical operations remain NULL.

begin;

create or replace function medclip_private.is_valid_music_failure_diagnostics(
  value jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if value is null then return true; end if;
  if jsonb_typeof(value) <> 'object' then return false; end if;
  if exists (
    select 1
    from jsonb_object_keys(value) as item(key_name)
    where key_name not in (
      'provider_response_received',
      'provider_http_status',
      'provider_error_code',
      'provider_error_class',
      'provider_failure_stage',
      'provider_response_classification',
      'provider_response_json_parseable',
      'provider_request_duration_ms'
    )
  ) then return false; end if;
  if not (value ? 'provider_response_received')
    or jsonb_typeof(value -> 'provider_response_received') <> 'boolean' then
    return false;
  end if;
  if value ? 'provider_http_status' then
    if jsonb_typeof(value -> 'provider_http_status') <> 'number'
      or (value ->> 'provider_http_status') !~ '^[0-9]{3}$'
      or (value ->> 'provider_http_status')::integer not between 100 and 599 then
      return false;
    end if;
  end if;
  if value ? 'provider_error_code' then
    if jsonb_typeof(value -> 'provider_error_code') <> 'string'
      or (value ->> 'provider_error_code') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' then
      return false;
    end if;
  end if;
  if not (value ? 'provider_error_class')
    or jsonb_typeof(value -> 'provider_error_class') <> 'string'
    or value ->> 'provider_error_class' not in (
      'POSTPAY_NOT_ENABLED',
      'QUOTA_EXHAUSTED',
      'INSUFFICIENT_BALANCE',
      'MODEL_ACCESS_DENIED',
      'PERMISSION_DENIED',
      'IP_NOT_ALLOWED',
      'INVALID_REQUEST',
      'UNSUPPORTED_FORMAT',
      'REQUEST_TOO_LARGE',
      'CONTENT_FILTERED',
      'RATE_LIMIT',
      'AUTHENTICATION',
      'PAYMENT_OR_QUOTA',
      'UPSTREAM_ERROR',
      'UPSTREAM_TIMEOUT',
      'NETWORK_ERROR',
      'TIMEOUT',
      'HTTP_ERROR',
      'BUSINESS_ERROR',
      'MALFORMED_JSON',
      'SUCCESS_SCHEMA_MISMATCH',
      'NOT_COMPLETED',
      'UNKNOWN'
    ) then return false;
  end if;
  if not (value ? 'provider_failure_stage')
    or jsonb_typeof(value -> 'provider_failure_stage') <> 'string'
    or value ->> 'provider_failure_stage' not in (
      'FETCH_DISPATCHED',
      'RESPONSE_RECEIVED',
      'HTTP_VALIDATED',
      'JSON_PARSED',
      'BUSINESS_STATUS_CHECKED',
      'SUCCESS_CORE_VALIDATED'
    ) then return false;
  end if;
  if not (value ? 'provider_response_classification')
    or jsonb_typeof(value -> 'provider_response_classification') <> 'string'
    or value ->> 'provider_response_classification' not in (
      'NO_RESPONSE',
      'HTTP_ERROR_JSON',
      'HTTP_ERROR_NON_JSON',
      'BUSINESS_ERROR',
      'MALFORMED_JSON',
      'SUCCESS_SCHEMA_MISMATCH',
      'NOT_COMPLETED',
      'UNKNOWN'
    ) then return false;
  end if;
  if not (value ? 'provider_response_json_parseable')
    or jsonb_typeof(value -> 'provider_response_json_parseable') <> 'boolean' then
    return false;
  end if;
  if not (value ? 'provider_request_duration_ms')
    or jsonb_typeof(value -> 'provider_request_duration_ms') <> 'number'
    or (value ->> 'provider_request_duration_ms')::numeric not between 0 and 300000 then
    return false;
  end if;
  if not (value ->> 'provider_response_received')::boolean
    and value ? 'provider_http_status' then
    return false;
  end if;
  return true;
exception when others then
  return false;
end;
$$;

revoke execute on function medclip_private.is_valid_music_failure_diagnostics(jsonb)
  from public, anon, authenticated;
grant execute on function medclip_private.is_valid_music_failure_diagnostics(jsonb)
  to service_role;

alter table medclip_private.music_generation_operations
  add column if not exists failure_diagnostics jsonb;

alter table medclip_private.music_generation_operations
  drop constraint if exists music_generation_operations_failure_diagnostics_safe;
alter table medclip_private.music_generation_operations
  add constraint music_generation_operations_failure_diagnostics_safe
  check (medclip_private.is_valid_music_failure_diagnostics(failure_diagnostics));

alter table medclip_private.music_generation_operations
  drop constraint if exists music_generation_operations_failure_diagnostics_state_safe;
alter table medclip_private.music_generation_operations
  add constraint music_generation_operations_failure_diagnostics_state_safe
  check (failure_diagnostics is null or state in ('FAILED', 'UNKNOWN'));

drop function if exists public.medclip_transition_music_generation_operation(
  uuid, text, text, text, smallint, text, text, uuid, text
);

create function public.medclip_transition_music_generation_operation(
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
    (expected_state = 'RESERVED' and next_state = 'PROVIDER_IN_FLIGHT' and next_provider_call_count = 1)
    or (expected_state = 'RESERVED' and next_state = 'FAILED' and next_provider_call_count = 0)
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

revoke execute on function public.medclip_transition_music_generation_operation(
  uuid, text, text, text, smallint, text, text, uuid, text, jsonb
) from public, anon, authenticated;
grant execute on function public.medclip_transition_music_generation_operation(
  uuid, text, text, text, smallint, text, text, uuid, text, jsonb
) to service_role;

commit;
