CREATE TYPE "public"."staff_role" AS ENUM('ops_admin', 'ops_viewer');--> statement-breakpoint
CREATE TYPE "public"."staff_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "staff_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"role" "staff_role" NOT NULL,
	"status" "staff_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_users_email_unique" UNIQUE("email"),
	CONSTRAINT "staff_users_email_lowercase" CHECK ("staff_users"."email" = lower("staff_users"."email"))
);
