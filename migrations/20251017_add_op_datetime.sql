alter table finance.operations add column if not exists op_datetime timestamp with time zone;

create index if not exists operations_bank_op_datetime_idx on finance.operations (bank, op_datetime desc);
-- additional enrichments
alter table finance.operations add column if not exists details jsonb;
alter table finance.operations add column if not exists id_hash text;

create index if not exists operations_details_gin on finance.operations using gin (details);
drop index if exists operations_bank_identity_uniq;
create unique index if not exists operations_bank_idhash_uniq on finance.operations (bank, id_hash) where id_hash is not null;
