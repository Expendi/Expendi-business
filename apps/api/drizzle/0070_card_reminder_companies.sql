-- Companies with a Card purchase that could still be missing its receipt: IDs
-- only, like reminder_companies. Which purchases actually need a reminder is
-- read inside each company's scope.
CREATE FUNCTION card_reminder_companies()
  RETURNS TABLE (organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT DISTINCT p.organization_id
    FROM card_purchases p
    WHERE p.kind = 'purchase'
      AND p.status IN ('pending', 'settled')
      AND p.authorized_at < now() - interval '24 hours'
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION card_reminder_companies() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION card_reminder_companies() TO expendi_business_app;
