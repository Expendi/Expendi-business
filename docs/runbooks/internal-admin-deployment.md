# Internal admin deployment

## Deployment record — 2026-11-02

- GitHub deployment repository: `https://github.com/DennohKim/expendi-admin` (private, branch `main`). It retains the monorepo because the admin app imports shared workspace packages.
- Source release: `c31bef2`, including the staff importer from `5454dee`.
- Vercel scope: `dennohkims-projects`, existing Hobby plan.
- Vercel project: `expendi-admin` (`prj_BAP9xOnTcKzc7zyp5xnQSVlDqvzo`).
- Root directory: `apps/admin`; outside-root source enabled; Node 22.x.
- Build/install commands: `apps/admin/vercel.json`. The build includes the admin typecheck.
- Successful production deployment: `dpl_8e9qScCsHFyzx8rC2W6Hj2H2zNb4`.
- Working URL: `https://expendi-admin.vercel.app`.
- Custom domain attached: `expendibiz-admin.expendi.app`; DNS is still pending.
- Public Vercel variables in production/preview/development: `NEXT_PUBLIC_API_URL=https://api-dev-dcdc.up.railway.app` and the existing `NEXT_PUBLIC_PRIVY_APP_ID`.
- Backend remains the dev Railway API. Its active deployment was verified as `5454dee` with status SUCCESS. No new database operation was performed for the admin deployment.

The admin deployment uses the committed source release. Concurrent, uncommitted admin/web/mobile redesign files were not included.

## Finish custom-domain setup

In Cloudflare's `expendi.app` zone, add:

| Type  | Name               | Target                                | Proxy    |
| ----- | ------------------ | ------------------------------------- | -------- |
| CNAME | `expendibiz-admin` | `1ce549c5387421cd.vercel-dns-017.com` | DNS only |

Then verify DNS and TLS:

```sh
vercel domains verify expendibiz-admin.expendi.app --scope dennohkims-projects
curl -I https://expendibiz-admin.expendi.app
```

Cloudflare credentials were unavailable in this session. The custom hostname did not resolve at final verification.

## API access and login

`ADMIN_APP_ORIGINS` in Doppler `expendi-business/dev` now includes the custom domain and `https://expendi-admin.vercel.app`, preserving `http://localhost:3001`. The Railway API was restarted to load that setting.

Verified:

- Vercel build/typecheck succeeded; homepage returns HTTP 200 with title `Expendi Business Ops`.
- All 24 referenced JavaScript assets load, and the client bundles contain the intended API URL and Privy app ID.
- API preflight requests allow both admin origins, including the sign-in session POST.
- Unauthenticated `/internal/me` returns HTTP 401 with the expected CORS header.
- Privy's app configuration currently has an empty `allowed_domains` list; no Privy configuration was changed.

A real staff email sign-in and authenticated Zoho/import screen walkthrough remain to be verified. The recorded staff login is `hello@cradlelabs.io`; a customer-company admin role alone does not grant internal staff access.

## Future releases

Push committed releases to `DennohKim/expendi-admin` branch `main` to trigger its Vercel Git integration. Pushing only to `Expendi/Expendi-business` does not update this separate deployment repository. Preserve the shared monorepo history; do not force-push.
