CREATE TABLE "demo_accounts" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"password_enc" text,
	"claimed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "demo_accounts" ADD CONSTRAINT "demo_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Food workspaces made before this: write-offs go to Spoilage and Shrinkage (shared/templates.ts).
UPDATE "accounts" a SET "system_key" = 'spoilage'
FROM "workspaces" w
WHERE a."workspace_id" = w."id" AND w."template" = 'food' AND a."code" = '5200' AND a."type" = 'expense'
  AND NOT EXISTS (SELECT 1 FROM "accounts" x WHERE x."workspace_id" = w."id" AND x."system_key" = 'spoilage');
