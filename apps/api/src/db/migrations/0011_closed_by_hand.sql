ALTER TABLE "purchase_orders" ADD COLUMN "closed_by_hand" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD COLUMN "closed_by_hand" boolean DEFAULT false NOT NULL;