alter table finance.operations add column if not exists op_time timestamp with time zone;
alter table finance.operations add column if not exists op_datetime_text text;
alter table finance.operations add column if not exists op_id text;
alter table finance.operations add column if not exists account_name text;
alter table finance.operations add column if not exists account_mask text;
alter table finance.operations add column if not exists counterparty text;
alter table finance.operations add column if not exists counterparty_phone text;
alter table finance.operations add column if not exists counterparty_bank text;
alter table finance.operations add column if not exists fee_amount numeric(14,2);
alter table finance.operations add column if not exists total_amount numeric(14,2);
alter table finance.operations add column if not exists channel text;

create unique index if not exists operations_bank_op_id_uniq on finance.operations (bank, op_id) where op_id is not null;
create index if not exists operations_bank_date_amount_text_idx on finance.operations (bank, op_date, amount, text);

