-- Analyst rollups. Phase 8 Day 2.
-- These are pure SQL views over Postgres; no analytics warehouse needed at
-- this scale.

create or replace view campaign_performance as
select
  c.id                              as campaign_id,
  c.slug                            as campaign_slug,
  count(distinct ci.id)             as content_items,
  count(distinct case when ci.status = 'published' then ci.id end) as published_items,
  count(distinct pj.id) filter (where pj.status = 'succeeded') as successful_publishes,
  count(distinct pj.id) filter (where pj.status = 'failed')    as failed_publishes
from campaigns c
left join content_items ci on ci.campaign_id = c.id
left join publish_jobs  pj on pj.content_id  = ci.id
group by c.id, c.slug;

create or replace view stage_performance as
select
  ci.stage,
  count(*)                                 as content_count,
  count(*) filter (where ci.status = 'published') as published_count,
  avg(extract(epoch from (ci.published_at - ci.created_at)) / 3600.0)::numeric(10, 2)
                                           as avg_hours_to_publish
from content_items ci
where ci.status = 'published'
group by ci.stage;

create or replace view channel_performance as
select
  pj.channel,
  count(*)                                       as job_count,
  count(*) filter (where pj.status = 'succeeded') as succeeded,
  count(*) filter (where pj.status = 'failed')    as failed,
  avg(pj.attempts)::numeric(10, 2)                as avg_attempts
from publish_jobs pj
group by pj.channel;
