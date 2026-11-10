-- Additive validation for safe request-shape diagnostics.
-- No user content, request bodies, credentials, or provider response bodies are stored.

begin;

create or replace function medclip_private.is_valid_music_failure_diagnostics(
  value jsonb
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  request_shape jsonb;
  field_value jsonb;
  field_name text;
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
      'provider_request_id',
      'provider_trace_id',
      'provider_error_class',
      'provider_failure_stage',
      'provider_response_classification',
      'provider_response_json_parseable',
      'provider_request_duration_ms',
      'request_shape'
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
  for field_name in select unnest(array['provider_request_id', 'provider_trace_id']) loop
    if value ? field_name then
      if jsonb_typeof(value -> field_name) <> 'string'
        or (value ->> field_name) !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' then
        return false;
      end if;
    end if;
  end loop;
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

  if value ? 'request_shape' then
    request_shape := value -> 'request_shape';
    if jsonb_typeof(request_shape) <> 'object'
      or exists (
        select 1
        from jsonb_object_keys(request_shape) as item(key_name)
        where key_name not in ('input_mode', 'fields', 'audio_setting_fields')
      )
      or not (request_shape ? 'input_mode')
      or not (request_shape ? 'fields')
      or not (request_shape ? 'audio_setting_fields') then
      return false;
    end if;
    if jsonb_typeof(request_shape -> 'input_mode') <> 'string'
      or request_shape ->> 'input_mode' not in ('custom_lyrics', 'instrumental') then
      return false;
    end if;
    if jsonb_typeof(request_shape -> 'fields') <> 'object'
      or jsonb_typeof(request_shape -> 'audio_setting_fields') <> 'object' then
      return false;
    end if;
    if (select count(*) from jsonb_object_keys(request_shape -> 'fields')) <> 6
      or (select count(*) from jsonb_object_keys(request_shape -> 'audio_setting_fields')) <> 3
      or exists (
        select 1
        from jsonb_object_keys(request_shape -> 'fields') as item(key_name)
        where key_name not in ('model', 'output_format', 'audio_setting', 'prompt', 'lyrics', 'is_instrumental')
      )
      or exists (
        select 1
        from jsonb_object_keys(request_shape -> 'audio_setting_fields') as item(key_name)
        where key_name not in ('sample_rate', 'bitrate', 'format')
      )
      or not (request_shape -> 'fields' ? 'model')
      or not (request_shape -> 'fields' ? 'output_format')
      or not (request_shape -> 'fields' ? 'audio_setting')
      or not (request_shape -> 'fields' ? 'prompt')
      or not (request_shape -> 'fields' ? 'lyrics')
      or not (request_shape -> 'fields' ? 'is_instrumental')
      or not (request_shape -> 'audio_setting_fields' ? 'sample_rate')
      or not (request_shape -> 'audio_setting_fields' ? 'bitrate')
      or not (request_shape -> 'audio_setting_fields' ? 'format') then
      return false;
    end if;
    for field_name in
      select key_name from jsonb_object_keys(request_shape -> 'fields') as item(key_name)
    loop
      field_value := (request_shape -> 'fields') -> field_name;
      if jsonb_typeof(field_value) <> 'object'
        or exists (
          select 1
          from jsonb_object_keys(field_value) as item(key_name)
          where key_name not in ('present', 'type', 'valid', 'length', 'enum_valid')
        )
        or not (field_value ? 'present')
        or not (field_value ? 'type')
        or not (field_value ? 'valid')
        or jsonb_typeof(field_value -> 'present') <> 'boolean'
        or jsonb_typeof(field_value -> 'type') <> 'string'
        or jsonb_typeof(field_value -> 'valid') <> 'boolean'
        or field_value ->> 'type' not in ('missing', 'null', 'array', 'object', 'string', 'number', 'boolean')
        or (field_value ->> 'present')::boolean <> ((field_value ->> 'type') <> 'missing') then
        return false;
      end if;
      if field_value ? 'length' then
        if field_value ->> 'type' <> 'string'
          or jsonb_typeof(field_value -> 'length') <> 'number'
          or (field_value ->> 'length') !~ '^[0-9]+$'
          or (field_value ->> 'length')::integer not between 0 and 10000 then
          return false;
        end if;
      end if;
      if field_value ? 'enum_valid'
        and jsonb_typeof(field_value -> 'enum_valid') <> 'boolean' then
        return false;
      end if;
    end loop;
    for field_name in
      select key_name from jsonb_object_keys(request_shape -> 'audio_setting_fields') as item(key_name)
    loop
      field_value := (request_shape -> 'audio_setting_fields') -> field_name;
      if jsonb_typeof(field_value) <> 'object'
        or exists (
          select 1
          from jsonb_object_keys(field_value) as item(key_name)
          where key_name not in ('present', 'type', 'valid', 'length', 'enum_valid')
        )
        or not (field_value ? 'present')
        or not (field_value ? 'type')
        or not (field_value ? 'valid')
        or jsonb_typeof(field_value -> 'present') <> 'boolean'
        or jsonb_typeof(field_value -> 'type') <> 'string'
        or jsonb_typeof(field_value -> 'valid') <> 'boolean'
        or field_value ->> 'type' not in ('missing', 'null', 'array', 'object', 'string', 'number', 'boolean')
        or (field_value ->> 'present')::boolean <> ((field_value ->> 'type') <> 'missing') then
        return false;
      end if;
      if field_value ? 'length' then
        if field_value ->> 'type' <> 'string'
          or jsonb_typeof(field_value -> 'length') <> 'number'
          or (field_value ->> 'length') !~ '^[0-9]+$'
          or (field_value ->> 'length')::integer not between 0 and 10000 then
          return false;
        end if;
      end if;
      if field_value ? 'enum_valid'
        and jsonb_typeof(field_value -> 'enum_valid') <> 'boolean' then
        return false;
      end if;
    end loop;
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

commit;
