-- Stock moves are the stock ledger: like posted journal entries (0002), they're never changed or
-- deleted. Corrections are new moves. The same purge escape hatch lets a workspace be deleted.
CREATE FUNCTION erp_stock_moves_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF erp_purging() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Stock movements can''t be changed or deleted. Make an adjustment instead.' USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
CREATE TRIGGER stock_moves_guard BEFORE UPDATE OR DELETE ON stock_moves
  FOR EACH ROW EXECUTE FUNCTION erp_stock_moves_guard();
--> statement-breakpoint

-- Workspaces made before Phase 3 get what new ones start with (see features/finance/seed.ts).
INSERT INTO accounts (workspace_id, code, name, type, system_key)
SELECT w.id, a.code, a.name, a.type::account_type, a.key
FROM workspaces w
CROSS JOIN (VALUES
  ('2010', 'Goods Received Not Invoiced', 'liability', 'grni'),
  ('3900', 'Opening Balance Equity', 'equity', 'opening_equity'),
  ('5150', 'Inventory Gains and Losses', 'expense', 'inventory_adjustments'),
  ('5160', 'Purchase Price Variance', 'expense', 'price_variance')
) AS a(code, name, type, key)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO sequences (workspace_id, kind, prefix)
SELECT w.id, s.kind, s.prefix
FROM workspaces w
CROSS JOIN (VALUES ('purchase_order', 'PO-'), ('goods_receipt', 'GR-'), ('stock_adjustment', 'ADJ-'), ('stock_transfer', 'TR-')) AS s(kind, prefix)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO units (workspace_id, code, name)
SELECT w.id, u.code, u.name
FROM workspaces w
CROSS JOIN (VALUES ('pc', 'Piece'), ('box', 'Box'), ('pack', 'Pack'), ('dozen', 'Dozen'), ('set', 'Set'), ('kg', 'Kilogram'), ('g', 'Gram'),
  ('L', 'Liter'), ('mL', 'Milliliter'), ('m', 'Meter'), ('sack', 'Sack'), ('bottle', 'Bottle'), ('can', 'Can'), ('roll', 'Roll')) AS u(code, name)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO warehouses (workspace_id, code, name)
SELECT w.id, 'MAIN', 'Main warehouse' FROM workspaces w
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- the new permissions: everything for owners and admins, seeing stock for the other built-in roles
UPDATE roles SET permissions = permissions || ARRAY['inventory.view','inventory.manage','purchasing.manage']::text[]
WHERE key IN ('owner', 'admin') AND NOT ('inventory.view' = ANY(permissions));
--> statement-breakpoint
UPDATE roles SET permissions = permissions || ARRAY['inventory.view']::text[]
WHERE key IS NULL AND name IN ('Accountant', 'Bookkeeper', 'Viewer') AND NOT ('inventory.view' = ANY(permissions));
--> statement-breakpoint
INSERT INTO roles (workspace_id, name, description, permissions)
SELECT w.id, 'Warehouse staff', 'Receives goods, counts and moves stock.', ARRAY['members.view','inventory.view','inventory.manage']::text[]
FROM workspaces w
ON CONFLICT DO NOTHING;
