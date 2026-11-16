-- Government rates (the same for every workspace). Check each against the latest issuance before relying on it;
-- a new circular is a new row with a later effective date, never an edit.
INSERT INTO gov_rates (kind, effective_from, data, source) VALUES
  ('sss', '2025-01-01', '{"minMsc": 500000, "maxMsc": 3500000, "step": 50000, "eeBp": 500, "erBp": 1000, "ecThreshold": 1500000, "ecLow": 1000, "ecHigh": 3000}'::jsonb, 'SSS Circular 2024-006 (RA 11199): 15% of the monthly salary credit, ₱5,000 to ₱35,000'),
  ('philhealth', '2024-01-01', '{"rateBp": 500, "floor": 1000000, "ceiling": 10000000}'::jsonb, 'PhilHealth Circular 2020-0005 (RA 11223): 5% of basic salary, ₱10,000 floor, ₱100,000 ceiling, shared equally'),
  ('pagibig', '2024-02-01', '{"lowThreshold": 150000, "eeLowBp": 100, "eeBp": 200, "erBp": 200, "maxBase": 1000000}'::jsonb, 'HDMF Circular 460: 2% each on up to ₱10,000 (1% for employees earning ₱1,500 or less)'),
  ('wtax', '2023-01-01', '{"semi_monthly": [{"over": 1041700, "base": 0, "rateBp": 1500}, {"over": 1666700, "base": 93750, "rateBp": 2000}, {"over": 3333300, "base": 427070, "rateBp": 2500}, {"over": 8333300, "base": 1677070, "rateBp": 3000}, {"over": 33333300, "base": 9177070, "rateBp": 3500}], "monthly": [{"over": 2083300, "base": 0, "rateBp": 1500}, {"over": 3333300, "base": 187500, "rateBp": 2000}, {"over": 6666700, "base": 854180, "rateBp": 2500}, {"over": 16666700, "base": 3354180, "rateBp": 3000}, {"over": 66666700, "base": 18354180, "rateBp": 3500}], "annual": [{"over": 25000000, "base": 0, "rateBp": 1500}, {"over": 40000000, "base": 2250000, "rateBp": 2000}, {"over": 80000000, "base": 10250000, "rateBp": 2500}, {"over": 200000000, "base": 40250000, "rateBp": 3000}, {"over": 800000000, "base": 220250000, "rateBp": 3500}]}'::jsonb, 'RR 11-2018 (TRAIN, RA 10963): withholding tax table for 2023 onwards'),
  ('premiums', '1990-01-01', '{"regularOvertime": 125, "dayOvertime": 130, "nightBp": 1000, "days": {"rest": 130, "special": 130, "special_rest": 150, "holiday": 200, "holiday_rest": 260}}'::jsonb, 'Labor Code arts. 86, 87, 93, 94 and DOLE holiday pay rules'),
  ('thirteenth', '2018-01-01', '{"thirteenthExempt": 9000000}'::jsonb, 'PD 851; TRAIN (RA 10963): 13th month and other benefits exempt up to ₱90,000'),
  ('minimum_wage', '2025-07-18', '{"130000000": {"region": "NCR", "daily": 69500}}'::jsonb, 'Wage Order NCR-26: ₱695 a day (non-agriculture)'),
  ('minimum_wage', '2026-09-26', '{"130000000": {"region": "NCR", "daily": 75500}}'::jsonb, 'Wage Order NCR-28: ₱755 a day (non-agriculture). Check its status with the RTWPB-NCR')
ON CONFLICT DO NOTHING;
--> statement-breakpoint


-- Payroll posts to accounts the system now knows by key. Older workspaces had most of them without keys.
UPDATE accounts SET system_key = v.k
FROM (VALUES ('2130', 'wtax_comp_payable'), ('2140', 'sss_payable'), ('2150', 'philhealth_payable'), ('2160', 'pagibig_payable'),
             ('6000', 'salaries'), ('6010', 'contributions_expense')) AS v(code, k)
WHERE accounts.code = v.code AND accounts.system_key IS NULL
  AND NOT EXISTS (SELECT 1 FROM accounts a2 WHERE a2.workspace_id = accounts.workspace_id AND a2.system_key = v.k);
--> statement-breakpoint
INSERT INTO accounts (workspace_id, code, name, type, system_key)
SELECT w.id, a.code, a.name, a.type::account_type, a.key
FROM workspaces w
CROSS JOIN (VALUES
  ('2210', 'Salaries Payable', 'liability', 'salaries_payable'),
  ('2220', 'Other Payroll Deductions Payable', 'liability', 'payroll_deductions'),
  ('6020', '13th Month Pay', 'expense', 'thirteenth_month')
) AS a(code, name, type, key)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO sequences (workspace_id, kind, prefix)
SELECT w.id, s.kind, s.prefix FROM workspaces w
CROSS JOIN (VALUES ('employee', 'EMP-'), ('payroll_run', 'PR-')) AS s(kind, prefix)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

UPDATE roles SET permissions = permissions || ARRAY['hr.view','hr.manage','payroll.run']::text[]
WHERE key IN ('owner', 'admin') AND NOT ('hr.view' = ANY(permissions));
--> statement-breakpoint
UPDATE roles SET permissions = permissions || ARRAY['hr.view']::text[]
WHERE key IS NULL AND name = 'Accountant' AND NOT ('hr.view' = ANY(permissions));
--> statement-breakpoint
INSERT INTO roles (workspace_id, name, description, permissions)
SELECT w.id, 'HR & payroll', 'Keeps employee records, approves leave and runs payroll.', ARRAY['members.view','members.invite','hr.view','hr.manage','payroll.run']::text[]
FROM workspaces w
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO leave_types (workspace_id, code, name, paid, days_per_year)
SELECT w.id, t.code, t.name, t.paid, t.days FROM workspaces w
CROSS JOIN (VALUES ('SIL', 'Service incentive leave', true, 5), ('VL', 'Vacation leave', true, 5), ('SL', 'Sick leave', true, 5),
  ('ML', 'Maternity leave', true, 105), ('PL', 'Paternity leave', true, 7), ('SPL', 'Solo parent leave', true, 7),
  ('VAWC', 'VAWC leave', true, 10), ('SLW', 'Special leave for women', true, 60), ('LWOP', 'Leave without pay', false, NULL)) AS t(code, name, paid, days)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Proclamation No. 1006 (2025)
INSERT INTO holidays (workspace_id, date, name, kind)
SELECT w.id, h.d::date, h.n, h.k FROM workspaces w
CROSS JOIN (VALUES
  ('2026-01-01', 'New Year’s Day', 'regular'),
  ('2026-02-17', 'Chinese New Year', 'special'),
  ('2026-04-02', 'Maundy Thursday', 'regular'),
  ('2026-04-03', 'Good Friday', 'regular'),
  ('2026-04-04', 'Black Saturday', 'special'),
  ('2026-04-09', 'Araw ng Kagitingan', 'regular'),
  ('2026-05-01', 'Labor Day', 'regular'),
  ('2026-06-12', 'Independence Day', 'regular'),
  ('2026-08-21', 'Ninoy Aquino Day', 'special'),
  ('2026-08-31', 'National Heroes Day', 'regular'),
  ('2026-11-01', 'All Saints’ Day', 'special'),
  ('2026-11-02', 'All Souls’ Day', 'special'),
  ('2026-11-30', 'Bonifacio Day', 'regular'),
  ('2026-12-08', 'Feast of the Immaculate Conception', 'special'),
  ('2026-12-24', 'Christmas Eve', 'special'),
  ('2026-12-25', 'Christmas Day', 'regular'),
  ('2026-12-30', 'Rizal Day', 'regular'),
  ('2026-12-31', 'Last Day of the Year', 'special')
) AS h(d, n, k)
ON CONFLICT DO NOTHING;
--> statement-breakpoint


-- Posted payroll is final, like posted documents (0002): its lines can't change, and the run can only
-- be marked paid. Mistakes are corrected in the next payroll.
CREATE FUNCTION erp_payroll_runs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF erp_purging() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'A posted payroll can''t be deleted.' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'posted' AND NEW.status = 'paid'
     AND (to_jsonb(NEW) - 'status' - 'payment_entry_id' - 'updated_at') = (to_jsonb(OLD) - 'status' - 'payment_entry_id' - 'updated_at') THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'A posted payroll can''t be changed. Correct it in the next payroll.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_runs_guard BEFORE UPDATE OR DELETE ON payroll_runs FOR EACH ROW EXECUTE FUNCTION erp_payroll_runs_guard();
--> statement-breakpoint
CREATE FUNCTION erp_payroll_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  st run_status;
BEGIN
  IF erp_purging() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO st FROM payroll_runs WHERE id = (CASE WHEN TG_OP = 'INSERT' THEN NEW.run_id ELSE OLD.run_id END);
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'A posted payroll can''t be changed. Correct it in the next payroll.' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER payroll_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON payroll_lines FOR EACH ROW EXECUTE FUNCTION erp_payroll_lines_guard();
