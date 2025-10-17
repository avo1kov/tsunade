alter table finance.operations add column if not exists op_datetime timestamp with time zone;

create index if not exists operations_bank_op_datetime_idx on finance.operations (bank, op_datetime desc);
