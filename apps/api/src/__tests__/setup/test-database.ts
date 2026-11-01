/**
 * Test database connection strings. Defaults match
 * `scripts/setup-local-db.sh`; override with TEST_DATABASE_URL and
 * TEST_DATABASE_URL_MIGRATE (e.g. in CI).
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://expendi_business_api@localhost:5432/expendi_business_test";

export const TEST_DATABASE_URL_MIGRATE =
  process.env.TEST_DATABASE_URL_MIGRATE ??
  "postgres://expendi_business_owner@localhost:5432/expendi_business_test";
