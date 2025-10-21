-- Drop legacy/unused columns from finance.operations
alter table finance.operations drop column if exists account_name;
alter table finance.operations drop column if exists account_mask;
alter table finance.operations drop column if exists counterparty;
alter table finance.operations drop column if exists counterparty_phone;
alter table finance.operations drop column if exists counterparty_bank;
alter table finance.operations drop column if exists message;
alter table finance.operations drop column if exists my_category;
alter table finance.operations drop column if exists op_time;
alter table finance.operations drop column if exists fee_amount;
alter table finance.operations drop column if exists total_amount;
alter table finance.operations drop column if exists channel;


