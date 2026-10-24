# Phase 2 — Supabase development setup

The development project URL and publishable key supplied by the owner are configured in `js/config.js`. The owner reports that the first SQL migration completed successfully in the development project (`Success. No rows returned`). Production remains untouched.

## Migration status

This migration has already been run successfully in the supplied development project. Do not run it again there unless we are recovering from a failed/partial run. The steps below are for a fresh project or for verification only.

1. Sign in to the Supabase Dashboard and open the development project whose URL is `https://oqlepcniuixoplvwsinr.supabase.co`.
2. Open **SQL Editor** and create a new query.
3. If this is a fresh development project, open `supabase/migrations/20261023000000_initial_schema.sql` in VS Code, copy the full file, paste it into the query, and run it once.
4. Confirm the query completes without errors.
5. In the SQL Editor, verify the tables exist: `restaurant_settings`, `staff_members`, `daily_order_counters`, `orders`, and `order_items`. The private verification/grant tables should be in the `private` schema.

This step creates schema and policies; it does not create staff login credentials or deploy Edge Functions. Do not paste a database password or secret API key into the SQL Editor query.

## Values needed by the browser

In the project dashboard, get the Project URL and **publishable** API key from the project connection details. The publishable key is designed for browser code, where RLS controls access. Enter it in `js/config.js` as `supabasePublishableKey`. Never use a key labelled Secret or `service_role` in the browser. Supabase's [API key guide](https://supabase.com/docs/guides/getting-started/api-keys) explains the distinction.

The project URL and publishable key have been added to `js/config.js`. A read-only request to `/auth/v1/settings` returned HTTP 200. The pages now show whether that endpoint is reachable, while making clear that order setup is incomplete. The pages do not yet initialize a Supabase Auth client; order functions remain disabled until Auth and server functions are configured.

## Auth settings and staff access

The project settings endpoint was rechecked after the owner changed Auth settings. It reports `anonymous_users: true`, `disable_signup: true`, and email sign-in enabled. The owner created a staff Auth user and added its UUID to `public.staff_members`; the UUID is not stored in this repository. Create any additional staff accounts manually in the Auth Dashboard, and keep their passwords private.

## Phase 2 verification state

- The owner reports that the initial SQL migration completed successfully in the supplied development project.
- Auth endpoint verification reports anonymous sign-in enabled, public sign-up disabled, and email sign-in enabled.
- The owner reports that one staff Auth UUID is authorized in `public.staff_members` and the SQL role simulations returned `true` for that staff UUID, `false` for a non-staff UUID, and `permission denied` for `anon` reading `public.orders`.
- These simulations confirm the basic staff/anonymous table boundary. They do not verify a deployed Edge Function or browser sign-in.
- Staff Edge Functions are implemented in source in Phase 3 but still need deployment. Customer order verification and tracking are not deployed; do not use customer tracking until that phase is implemented and verified.
