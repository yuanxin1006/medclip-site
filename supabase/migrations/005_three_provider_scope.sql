-- Permanently narrow the MedClip BYOK product scope to DeepSeek, Kimi, and Doubao.
-- This migration is intentionally non-destructive: it stops if legacy provider rows exist.

do $$
begin
  if exists (
    select 1
    from public.user_ai_provider_connections
    where provider in ('openai', 'gemini')
  ) or exists (
    select 1
    from medclip_private.user_ai_credentials
    where provider in ('openai', 'gemini')
  ) then
    raise exception 'Cannot narrow AI provider scope while legacy provider rows exist';
  end if;
end
$$;

alter table public.user_ai_provider_connections
  drop constraint user_ai_provider_connections_provider_allowed,
  add constraint user_ai_provider_connections_provider_allowed
    check (provider in ('deepseek', 'kimi', 'doubao'));

alter table medclip_private.user_ai_credentials
  drop constraint user_ai_credentials_provider_allowed,
  add constraint user_ai_credentials_provider_allowed
    check (provider in ('deepseek', 'kimi', 'doubao'));
