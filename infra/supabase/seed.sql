-- Seed defaults. Run once after migrations.

insert into settings (key, value) values
  ('kill_switch', 'false'::jsonb),
  ('channel_caps', '{"linkedin": 5, "x": 20, "internal_blog": 50, "email_hubspot": 5, "email_mailchimp": 5}'::jsonb),
  ('approval_policy', '{"mode": "single", "channels": []}'::jsonb)
on conflict (key) do nothing;
