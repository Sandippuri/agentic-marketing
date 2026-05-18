-- Seed defaults. Run once after migrations.
--
-- Targets the global fallback row (workspace_id IS NULL). Per migration
-- 0028, uniqueness on (key) is enforced by the partial unique index
-- `settings_global_key_uq`, which requires the matching WHERE clause on
-- the ON CONFLICT target.

insert into settings (workspace_id, key, value) values
  (null, 'kill_switch', 'false'::jsonb),
  (null, 'channel_caps', '{"linkedin": 5, "x": 20, "internal_blog": 50, "email_hubspot": 5, "email_mailchimp": 5}'::jsonb),
  (null, 'approval_policy', '{"mode": "single", "channels": []}'::jsonb)
on conflict (key) where workspace_id is null do nothing;
