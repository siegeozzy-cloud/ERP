CREATE TYPE "public"."billing_method" AS ENUM('fixed', 'hourly', 'none');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('planning', 'active', 'on_hold', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('todo', 'in_progress', 'done');--> statement-breakpoint
ALTER TYPE "public"."journal_source" ADD VALUE 'project';--> statement-breakpoint
CREATE TABLE "project_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"due_date" date NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	"done_at" timestamp with time zone,
	"invoice_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"milestone_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"assignee_id" uuid,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"estimated_hours" numeric(10, 2) DEFAULT 0 NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"status" "task_status" DEFAULT 'todo' NOT NULL,
	"depends_on_id" uuid,
	"field_work" boolean DEFAULT false NOT NULL,
	"location" text,
	"notes" text,
	"done_at" timestamp with time zone,
	"done_latitude" double precision,
	"done_longitude" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"number" text NOT NULL,
	"name" text NOT NULL,
	"customer_id" uuid,
	"manager_id" uuid,
	"status" "project_status" DEFAULT 'planning' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"billing" "billing_method" DEFAULT 'fixed' NOT NULL,
	"contract_value" bigint DEFAULT 0 NOT NULL,
	"hourly_rate" bigint DEFAULT 0 NOT NULL,
	"cost_budget" bigint DEFAULT 0 NOT NULL,
	"site_address" text,
	"description" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timesheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid,
	"employee_id" uuid NOT NULL,
	"date" date NOT NULL,
	"hours" numeric(6, 2) NOT NULL,
	"billable" boolean DEFAULT true NOT NULL,
	"note" text,
	"cost_rate" bigint DEFAULT 0 NOT NULL,
	"cost" bigint DEFAULT 0 NOT NULL,
	"invoice_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_invoice_id_sales_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."sales_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_milestone_id_project_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."project_milestones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_depends_on_id_project_tasks_id_fk" FOREIGN KEY ("depends_on_id") REFERENCES "public"."project_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_customer_id_contacts_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_task_id_project_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."project_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_invoice_id_sales_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."sales_invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheets" ADD CONSTRAINT "timesheets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_milestones_project_idx" ON "project_milestones" USING btree ("project_id","due_date");--> statement-breakpoint
CREATE INDEX "project_tasks_project_idx" ON "project_tasks" USING btree ("project_id","start_date");--> statement-breakpoint
CREATE INDEX "project_tasks_assignee_idx" ON "project_tasks" USING btree ("assignee_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_number_key" ON "projects" USING btree ("workspace_id","number");--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "timesheets_project_idx" ON "timesheets" USING btree ("project_id","date");--> statement-breakpoint
CREATE INDEX "timesheets_employee_idx" ON "timesheets" USING btree ("employee_id","date");--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_invoices" ADD CONSTRAINT "sales_invoices_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_moves" ADD CONSTRAINT "stock_moves_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Workspaces made before Phase 7 get what new ones start with (features/finance/seed.ts,
-- shared/templates.ts and shared/permissions.ts).
INSERT INTO sequences (workspace_id, kind, prefix) SELECT w.id, 'project', 'PRJ-' FROM workspaces w ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE accounts a SET system_key = 'service_revenue'
WHERE a.code = '4010' AND a.type = 'income' AND a.system_key IS NULL
  AND NOT EXISTS (SELECT 1 FROM accounts x WHERE x.workspace_id = a.workspace_id AND x.system_key = 'service_revenue');
--> statement-breakpoint
UPDATE accounts a SET system_key = 'contract_revenue'
FROM workspaces w
WHERE a.workspace_id = w.id AND w.template = 'construction' AND a.code = '4020' AND a.system_key IS NULL
  AND NOT EXISTS (SELECT 1 FROM accounts x WHERE x.workspace_id = a.workspace_id AND x.system_key = 'contract_revenue');
--> statement-breakpoint
INSERT INTO accounts (workspace_id, code, name, type, system_key)
SELECT w.id, '5600', 'Direct Project Costs', 'expense', 'project_costs' FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM accounts x WHERE x.workspace_id = w.id AND (x.system_key = 'project_costs' OR x.code = '5600'));
--> statement-breakpoint
UPDATE roles SET permissions = permissions || ARRAY['projects.view','projects.manage']::text[]
WHERE key IN ('owner', 'admin') AND NOT ('projects.view' = ANY(permissions));
--> statement-breakpoint
UPDATE roles SET permissions = permissions || ARRAY['projects.view']::text[]
WHERE key IS NULL AND name IN ('Accountant', 'Viewer') AND NOT ('projects.view' = ANY(permissions));
--> statement-breakpoint
INSERT INTO roles (workspace_id, name, description, permissions)
SELECT w.id, 'Project manager', 'Plans projects, assigns work, tracks time and costs, and bills milestones.', ARRAY['members.view','crm.view','inventory.view','projects.view','projects.manage']::text[]
FROM workspaces w
ON CONFLICT DO NOTHING;
