-- Add RRN column and backfill from details (label "RRN" case-insensitive)
alter table finance.operations add column if not exists rrn text;

-- Ensure unique constraint prefers rrn when present
drop index if exists finance.operations_bank_rrn_uniq;
drop index if exists operations_bank_rrn_uniq;
create unique index if not exists operations_bank_rrn_uniq on finance.operations (bank, rrn) where rrn is not null;

-- Scope id_hash uniqueness to rows without rrn
drop index if exists finance.operations_bank_idhash_uniq;
drop index if exists operations_bank_idhash_uniq;
create unique index if not exists operations_bank_idhash_uniq on finance.operations (bank, id_hash) where id_hash is not null and rrn is null;


