CREATE TYPE "public"."wo_status" AS ENUM('draft', 'released', 'in_progress', 'completed', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."journal_source" ADD VALUE 'production';--> statement-breakpoint
ALTER TYPE "public"."move_kind" ADD VALUE 'consume';--> statement-breakpoint
ALTER TYPE "public"."move_kind" ADD VALUE 'produce';--> statement-breakpoint
CREATE TABLE "bom_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"bom_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" numeric(18, 4) DEFAULT 0 NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "bom_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"bom_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"work_center_id" uuid NOT NULL,
	"description" text NOT NULL,
	"minutes" numeric(10, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "boms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"output_qty" numeric(18, 4) DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"qc_checks" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wo_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"item_id" uuid NOT NULL,
	"planned_qty" numeric(18, 4) DEFAULT 0 NOT NULL,
	"issued_qty" numeric(18, 4) DEFAULT 0 NOT NULL,
	"issued_value" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wo_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"work_order_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"work_center_id" uuid NOT NULL,
	"description" text NOT NULL,
	"planned_minutes" numeric(10, 2) NOT NULL,
	"actual_minutes" numeric(10, 2),
	"cost_per_hour" bigint DEFAULT 0 NOT NULL,
	"cost" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_centers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"cost_per_hour" bigint DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"number" text,
	"status" "wo_status" DEFAULT 'draft' NOT NULL,
	"bom_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"quantity" numeric(18, 4) DEFAULT 0 NOT NULL,
	"good_qty" numeric(18, 4) DEFAULT 0 NOT NULL,
	"rejected_qty" numeric(18, 4) DEFAULT 0 NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"due_date" date NOT NULL,
	"sales_order_id" uuid,
	"notes" text,
	"qc_checks" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"qc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lot_id" uuid,
	"material_cost" bigint DEFAULT 0 NOT NULL,
	"conversion_cost" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stock_moves" ADD COLUMN "work_order_id" uuid;--> statement-breakpoint
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_bom_id_boms_id_fk" FOREIGN KEY ("bom_id") REFERENCES "public"."boms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_lines" ADD CONSTRAINT "bom_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_operations" ADD CONSTRAINT "bom_operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_operations" ADD CONSTRAINT "bom_operations_bom_id_boms_id_fk" FOREIGN KEY ("bom_id") REFERENCES "public"."boms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bom_operations" ADD CONSTRAINT "bom_operations_work_center_id_work_centers_id_fk" FOREIGN KEY ("work_center_id") REFERENCES "public"."work_centers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boms" ADD CONSTRAINT "boms_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boms" ADD CONSTRAINT "boms_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boms" ADD CONSTRAINT "boms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wo_materials" ADD CONSTRAINT "wo_materials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wo_materials" ADD CONSTRAINT "wo_materials_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wo_materials" ADD CONSTRAINT "wo_materials_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wo_operations" ADD CONSTRAINT "wo_operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wo_operations" ADD CONSTRAINT "wo_operations_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wo_operations" ADD CONSTRAINT "wo_operations_work_center_id_work_centers_id_fk" FOREIGN KEY ("work_center_id") REFERENCES "public"."work_centers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_centers" ADD CONSTRAINT "work_centers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_bom_id_boms_id_fk" FOREIGN KEY ("bom_id") REFERENCES "public"."boms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bom_lines_bom_idx" ON "bom_lines" USING btree ("bom_id");--> statement-breakpoint
CREATE INDEX "bom_lines_item_idx" ON "bom_lines" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "bom_operations_bom_idx" ON "bom_operations" USING btree ("bom_id");--> statement-breakpoint
CREATE UNIQUE INDEX "boms_version_key" ON "boms" USING btree ("item_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "boms_one_active" ON "boms" USING btree ("item_id") WHERE "boms"."active";--> statement-breakpoint
CREATE INDEX "wo_materials_wo_idx" ON "wo_materials" USING btree ("work_order_id");--> statement-breakpoint
CREATE INDEX "wo_operations_wo_idx" ON "wo_operations" USING btree ("work_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_centers_code_key" ON "work_centers" USING btree ("workspace_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "work_orders_number_key" ON "work_orders" USING btree ("workspace_id","number");--> statement-breakpoint
CREATE INDEX "work_orders_status_idx" ON "work_orders" USING btree ("workspace_id","status","due_date");--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_moves_wo_idx" ON "stock_moves" USING btree ("work_order_id");--> statement-breakpoint
-- Workspaces made before Phase 6 get what new ones start with (features/finance/seed.ts and
-- packages/shared/src/permissions.ts): the WO- series, Work in Process and Labor and Overhead
-- Applied accounts, the Manufacturing permissions and the Production staff role.
INSERT INTO sequences (workspace_id, kind, prefix) SELECT w.id, 'work_order', 'WO-' FROM workspaces w ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE accounts a SET system_key = 'wip'
WHERE a.code = '1215' AND a.type = 'asset' AND a.system_key IS NULL
  AND NOT EXISTS (SELECT 1 FROM accounts x WHERE x.workspace_id = a.workspace_id AND x.system_key = 'wip');
--> statement-breakpoint
INSERT INTO accounts (workspace_id, code, name, type, system_key)
SELECT w.id, '1215', 'Work in Process', 'asset', 'wip' FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM accounts x WHERE x.workspace_id = w.id AND (x.system_key = 'wip' OR x.code = '1215'));
--> statement-breakpoint
INSERT INTO accounts (workspace_id, code, name, type, system_key)
SELECT w.id, '5410', 'Labor and Overhead Applied to Production', 'expense', 'applied_overhead' FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM accounts x WHERE x.workspace_id = w.id AND (x.system_key = 'applied_overhead' OR x.code = '5410'));
--> statement-breakpoint
UPDATE roles SET permissions = permissions || ARRAY['manufacturing.view','manufacturing.manage']::text[]
WHERE key IN ('owner', 'admin') AND NOT ('manufacturing.view' = ANY(permissions));
--> statement-breakpoint
UPDATE roles SET permissions = permissions || ARRAY['manufacturing.view']::text[]
WHERE key IS NULL AND name IN ('Accountant', 'Viewer', 'Warehouse staff') AND NOT ('manufacturing.view' = ANY(permissions));
--> statement-breakpoint
INSERT INTO roles (workspace_id, name, description, permissions)
SELECT w.id, 'Production staff', 'Runs work orders: issues materials, records output and quality checks.', ARRAY['members.view','inventory.view','manufacturing.view','manufacturing.manage']::text[]
FROM workspaces w
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- A completed work order is final, like a posted entry (0002): its stock moves and journal entries
-- stand. The purge setting lets a whole workspace be deleted.
CREATE FUNCTION erp_work_orders_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF erp_purging() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'A completed work order can''t be changed or deleted.' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Only a draft work order can be deleted. Cancel it instead.' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER work_orders_guard BEFORE UPDATE OR DELETE ON work_orders FOR EACH ROW EXECUTE FUNCTION erp_work_orders_guard();
