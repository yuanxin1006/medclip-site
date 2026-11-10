-- Extend the validated MedClip BYOK provider scope with Tencent Cloud TokenHub.
-- TokenHub uses API-key-only credentials; the existing resource-safe constraint
-- continues to require provider_resource_id IS NULL for every non-Doubao provider.

alter table public.user_ai_provider_connections
  drop constraint user_ai_provider_connections_provider_allowed,
  add constraint user_ai_provider_connections_provider_allowed
    check (provider in ('deepseek', 'kimi', 'doubao', 'tencent_tokenhub'));

alter table medclip_private.user_ai_credentials
  drop constraint user_ai_credentials_provider_allowed,
  add constraint user_ai_credentials_provider_allowed
    check (provider in ('deepseek', 'kimi', 'doubao', 'tencent_tokenhub'));
