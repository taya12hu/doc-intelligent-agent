CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_kind" text NOT NULL,
	"storage_path" text NOT NULL,
	"byte_size" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"escalated_to" text,
	"samples" integer DEFAULT 1 NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"latency_ms" integer,
	"tokens_in" integer,
	"tokens_out" integer,
	"repair_log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb,
	"status" text NOT NULL,
	"confidence" numeric(3, 2),
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"vendor_name" text,
	"invoice_number" text,
	"invoice_date" date,
	"currency" char(3),
	"subtotal" numeric(14, 2),
	"discount_total" numeric(14, 2),
	"tax_total" numeric(14, 2),
	"grand_total" numeric(14, 2),
	"is_current" boolean DEFAULT true NOT NULL,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"extraction_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"description" text,
	"quantity" numeric(14, 4),
	"unit_price" numeric(14, 4),
	"line_total" numeric(14, 2),
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_edited" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_extraction_id_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."extractions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_status_idx" ON "documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "documents_created_idx" ON "documents" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "extractions_document_current_idx" ON "extractions" USING btree ("document_id","is_current");--> statement-breakpoint
CREATE INDEX "line_items_extraction_idx" ON "line_items" USING btree ("extraction_id","position");