CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"summary" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "join_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"role_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_by" uuid,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "psgc_barangays" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"city_code" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "psgc_cities" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"region_code" text NOT NULL,
	"province_code" text,
	"is_city" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "psgc_provinces" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"region_code" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "psgc_regions" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"short_name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"permissions" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "role_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "street" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "region_code" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "province_code" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "city_code" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "barangay_code" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "template" text DEFAULT 'general' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "modules" text[] DEFAULT ARRAY['finance','inventory','crm','hr']::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "dpo_name" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "dpo_email" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_codes" ADD CONSTRAINT "join_codes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_codes" ADD CONSTRAINT "join_codes_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_codes" ADD CONSTRAINT "join_codes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "join_codes" ADD CONSTRAINT "join_codes_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_workspace_idx" ON "audit_log" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("workspace_id","entity");--> statement-breakpoint
CREATE UNIQUE INDEX "join_codes_hash_key" ON "join_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "join_codes_workspace_idx" ON "join_codes" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "psgc_barangays_city_idx" ON "psgc_barangays" USING btree ("city_code");--> statement-breakpoint
CREATE INDEX "psgc_cities_region_idx" ON "psgc_cities" USING btree ("region_code");--> statement-breakpoint
CREATE INDEX "psgc_cities_province_idx" ON "psgc_cities" USING btree ("province_code");--> statement-breakpoint
CREATE INDEX "psgc_provinces_region_idx" ON "psgc_provinces" USING btree ("region_code");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_name_key" ON "roles" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_key_key" ON "roles" USING btree ("workspace_id","key");--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memberships_role_idx" ON "memberships" USING btree ("role_id");