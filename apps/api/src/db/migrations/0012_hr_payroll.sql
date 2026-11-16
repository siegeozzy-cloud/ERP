CREATE TYPE "public"."leave_status" AS ENUM('pending', 'approved', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('draft', 'posted', 'paid');--> statement-breakpoint
ALTER TYPE "public"."journal_source" ADD VALUE 'payroll';--> statement-breakpoint
ALTER TYPE "public"."journal_source" ADD VALUE 'payroll_payment';--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"employee_no" text NOT NULL,
	"user_id" uuid,
	"first_name" text NOT NULL,
	"middle_name" text,
	"last_name" text NOT NULL,
	"birth_date" date,
	"email" text,
	"phone" text,
	"address" text,
	"position" text NOT NULL,
	"department" text,
	"employment_type" text DEFAULT 'regular' NOT NULL,
	"hire_date" date NOT NULL,
	"separation_date" date,
	"tin_enc" text,
	"sss_no_enc" text,
	"philhealth_no_enc" text,
	"pagibig_no_enc" text,
	"pay_basis" text DEFAULT 'monthly' NOT NULL,
	"rate" bigint DEFAULT 0 NOT NULL,
	"pay_frequency" text DEFAULT 'semi_monthly' NOT NULL,
	"work_days_per_year" integer DEFAULT 261 NOT NULL,
	"minimum_wage_earner" boolean DEFAULT false NOT NULL,
	"tracks_attendance" boolean DEFAULT true NOT NULL,
	"shift_start" text DEFAULT '08:00' NOT NULL,
	"rest_days" integer[] DEFAULT ARRAY[0]::integer[] NOT NULL,
	"work_region_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gov_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"effective_from" date NOT NULL,
	"data" jsonb NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"date" date NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"half_day" boolean DEFAULT false NOT NULL,
	"days" numeric(6, 1) NOT NULL,
	"reason" text,
	"status" "leave_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"paid" boolean NOT NULL,
	"days_per_year" numeric(6, 1),
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"pay_basis" text NOT NULL,
	"daily_rate" bigint DEFAULT 0 NOT NULL,
	"minimum_wage_earner" boolean NOT NULL,
	"inputs" jsonb NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"result" jsonb NOT NULL,
	"basic" bigint DEFAULT 0 NOT NULL,
	"gross" bigint DEFAULT 0 NOT NULL,
	"gross_taxable" bigint DEFAULT 0 NOT NULL,
	"non_taxable" bigint DEFAULT 0 NOT NULL,
	"taxable" bigint DEFAULT 0 NOT NULL,
	"sss_msc" bigint DEFAULT 0 NOT NULL,
	"sss_ee" bigint DEFAULT 0 NOT NULL,
	"sss_er" bigint DEFAULT 0 NOT NULL,
	"sss_ec" bigint DEFAULT 0 NOT NULL,
	"philhealth_base" bigint DEFAULT 0 NOT NULL,
	"philhealth_ee" bigint DEFAULT 0 NOT NULL,
	"philhealth_er" bigint DEFAULT 0 NOT NULL,
	"pagibig_base" bigint DEFAULT 0 NOT NULL,
	"pagibig_ee" bigint DEFAULT 0 NOT NULL,
	"pagibig_er" bigint DEFAULT 0 NOT NULL,
	"tax" bigint DEFAULT 0 NOT NULL,
	"other_deductions" bigint DEFAULT 0 NOT NULL,
	"net" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"number" text,
	"kind" text NOT NULL,
	"frequency" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"pay_date" date NOT NULL,
	"status" "run_status" DEFAULT 'draft' NOT NULL,
	"takes_contributions" boolean NOT NULL,
	"journal_entry_id" uuid,
	"payment_entry_id" uuid,
	"posted_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"clock_in" timestamp with time zone NOT NULL,
	"clock_out" timestamp with time zone,
	"in_latitude" double precision,
	"in_longitude" double precision,
	"in_accuracy" double precision,
	"out_latitude" double precision,
	"out_longitude" double precision,
	"out_accuracy" double precision,
	"source" text NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holidays" ADD CONSTRAINT "holidays_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_leave_type_id_leave_types_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_types" ADD CONSTRAINT "leave_types_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_run_id_payroll_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_payment_entry_id_journal_entries_id_fk" FOREIGN KEY ("payment_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employees_number_key" ON "employees" USING btree ("workspace_id","employee_no");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_user_key" ON "employees" USING btree ("workspace_id","user_id") WHERE "employees"."user_id" is not null;--> statement-breakpoint
CREATE INDEX "employees_name_idx" ON "employees" USING btree ("workspace_id","last_name");--> statement-breakpoint
CREATE UNIQUE INDEX "gov_rates_key" ON "gov_rates" USING btree ("kind","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "holidays_date_key" ON "holidays" USING btree ("workspace_id","date");--> statement-breakpoint
CREATE INDEX "leave_requests_employee_idx" ON "leave_requests" USING btree ("employee_id","start_date");--> statement-breakpoint
CREATE INDEX "leave_requests_workspace_idx" ON "leave_requests" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_types_code_key" ON "leave_types" USING btree ("workspace_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_lines_employee_key" ON "payroll_lines" USING btree ("run_id","employee_id");--> statement-breakpoint
CREATE INDEX "payroll_lines_employee_idx" ON "payroll_lines" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_runs_number_key" ON "payroll_runs" USING btree ("workspace_id","number");--> statement-breakpoint
CREATE INDEX "payroll_runs_period_idx" ON "payroll_runs" USING btree ("workspace_id","period_end");--> statement-breakpoint
CREATE INDEX "time_entries_employee_idx" ON "time_entries" USING btree ("employee_id","clock_in");--> statement-breakpoint
CREATE INDEX "time_entries_workspace_idx" ON "time_entries" USING btree ("workspace_id","clock_in");--> statement-breakpoint
CREATE UNIQUE INDEX "time_entries_one_open" ON "time_entries" USING btree ("employee_id") WHERE "time_entries"."clock_out" is null;