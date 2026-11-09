-- Payment-link currency, so a currency change alone creates a new link.
alter table invoices add column stripe_link_currency char(3);
alter table payment_plan_installments add column stripe_link_currency char(3);
