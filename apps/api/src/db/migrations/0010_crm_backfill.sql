-- Workspaces made before Phase 4 get what new ones start with: the quote, sales order and delivery
-- number series (features/finance/seed.ts), the Sales & CRM permissions and the Sales role
-- (packages/shared/src/permissions.ts).
INSERT INTO sequences (workspace_id, kind, prefix)
SELECT w.id, s.kind, s.prefix
FROM workspaces w
CROSS JOIN (VALUES ('quote', 'QT-'), ('sales_order', 'SO-'), ('delivery', 'DR-')) AS s(kind, prefix)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- everything for owners and admins; seeing sales for the other built-in roles
UPDATE roles SET permissions = permissions || ARRAY['crm.view','crm.manage','sales.manage']::text[]
WHERE key IN ('owner', 'admin') AND NOT ('crm.view' = ANY(permissions));
--> statement-breakpoint
UPDATE roles SET permissions = permissions || ARRAY['crm.view']::text[]
WHERE key IS NULL AND name IN ('Accountant', 'Bookkeeper', 'Viewer', 'Warehouse staff') AND NOT ('crm.view' = ANY(permissions));
--> statement-breakpoint
INSERT INTO roles (workspace_id, name, description, permissions)
SELECT w.id, 'Sales', 'Works leads, makes quotes and takes orders.', ARRAY['members.view','crm.view','crm.manage','sales.manage']::text[]
FROM workspaces w
ON CONFLICT DO NOTHING;
