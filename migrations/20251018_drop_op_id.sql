-- drop unique index on (bank, op_id) if exists
drop index if exists finance.operations_bank_op_id_uniq;

-- drop op_id column if exists
alter table finance.operations drop column if exists op_id;

-- drop and recreate id_hash unique index without op_id predicate dependency
drop index if exists finance.operations_bank_idhash_uniq;
create unique index if not exists operations_bank_idhash_uniq on finance.operations (bank, id_hash) where id_hash is not null;

