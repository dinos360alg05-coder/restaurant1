# Phase 3 — Staff dashboard

The cashier page now contains staff sign-in, order creation, order queue, status controls, live refresh, and printable receipts. Order creation and status changes run through authenticated Supabase Edge Functions. The browser key remains publishable; the service-role key and tracking-code pepper stay in Supabase.

## Before using the cashier page

The owner reports that the first migration ran, a staff authorization row was added, and the SQL Editor checks returned `true` for that staff UUID, `false` for a non-staff UUID, and `permission denied` for `anon` reading `public.orders`. These checks confirm the basic staff/anonymous table boundary. They do not verify a deployed Edge Function or a browser sign-in.

The source changes in this phase are not live in Supabase until you apply the cashier migration and redeploy the `create-order` Edge Function. Keep the existing tracking pepper and the `transition-order` function as they are.

## One-time setup from Windows PowerShell

Apply `supabase/migrations/20261024030000_cashier_menu_and_order_totals.sql` to the existing development project: open it in VS Code, copy its full contents, paste them into the Supabase **SQL Editor**, and run it. It adds a staff-managed menu, order/customer/table/price fields, sample menu entries, and the server-side price calculation. It also enables live menu updates. The sample prices are starter values in Algerian dinars; edit them in the cashier menu before using them for real sales. Do not rerun the initial schema migration.

If the new order function returns SQLSTATE `42702`, apply `supabase/migrations/20261024050000_fix_menu_order_ambiguity.sql` in the SQL Editor. This replaces only the secure order function with the explicit column-resolution fix; no Edge Function redeploy is needed for this SQL correction.

To upload menu photos from the cashier, also run `supabase/migrations/20261024040000_menu_image_storage.sql` in the SQL Editor. Staff can then upload JPG, PNG, WebP, or AVIF images up to 5 MB. Direct public image URLs and public Google Drive share links are also supported; Drive files must allow access to anyone with the link.

Then run these commands in the project folder. The first `npx` call may download the Supabase CLI into npm's cache; Docker and the database password are not required for function deployment with the API option.

```powershell
npx supabase --version
npx supabase login
```

Generate a private pepper in PowerShell and copy its output directly into **Supabase Dashboard → Edge Functions → Secrets**. Add it under the name `TRACKING_CODE_PEPPER`. Do not save it in project files, Git, or `js/config.js`.

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Deploy the updated order function so it accepts menu item IDs and saves prices from the database:

```powershell
npx supabase functions deploy create-order --project-ref oqlepcniuixoplvwsinr --use-api
```

Supabase provides the function URL, Auth verification, and service-side environment values at runtime. Never set or paste a service-role key in frontend code. Keep public staff sign-up disabled.

## Use it

1. Keep the Node preview server running and open `http://localhost:4173/admin.html`.
2. Sign in with the manually created cashier email and password.
3. Review and edit the starter menu and prices with the **إدارة** button, or add more items with **إضافة صنف للمنيو**. A menu item can be marked unavailable without deleting it.
4. Enter the customer's name, choose dine-in or takeaway, and enter a table number for dine-in. Add menu items, adjust quantities, add an optional kitchen note, and set preparation time.
5. Submit the order. The server reads current menu prices and stores a price snapshot with the order, then prints the order number, item totals, grand total, and six-digit tracking code.
6. Use the status buttons in order: Received → Preparing → Ready → Delivered. Cancellation is available before a terminal status.

If a function returns `staff_access_required`, verify that this signed-in account's Auth UUID is the same UUID listed as active in `public.staff_members`. If order creation returns a configuration error, check that `TRACKING_CODE_PEPPER` was saved in the development project's Edge Function secrets and redeploy `create-order`.

## Customer tracking

The private tracking flow is implemented in source. Anonymous sign-in must be enabled in **Authentication → Sign In / Providers → Anonymous Sign-Ins**. Public email sign-up can remain disabled. Apply `supabase/migrations/20261024020000_customer_tracking.sql` in the Supabase SQL Editor after the existing schema and order-creation fix migrations.

Deploy the two customer functions from PowerShell in the project folder:

```powershell
npx supabase functions deploy verify-order --project-ref oqlepcniuixoplvwsinr --use-api
npx supabase functions deploy get-tracking --project-ref oqlepcniuixoplvwsinr --use-api
```

Keep `TRACKING_CODE_PEPPER` configured in Edge Function secrets. Open `customer.html`, enter the order number and six-digit code printed on the receipt, and leave the page open for automatic status refreshes. The tracking token and anonymous session are held in `sessionStorage` for the current tab; closing the tab ends the local session. Access expires after four hours, at the business-day change, 30 days after creation, or 15 minutes after delivery/cancellation, whichever comes first.

## Phase status

- Implemented in source: staff email/password sign-in, staff membership checks in each function, secure transactional order numbering, staff-editable menu, server-verified menu pricing, customer/table details, HMAC-protected access-code storage, receipt printing, database-enforced status transitions, and staff-only order reads.
- Implemented in source, deployment pending: Realtime publication for `public.orders`, create-order and transition-order Edge Functions.
- Owner action: apply the cashier migration, redeploy `create-order`, and replace the starter prices with the restaurant's actual prices before real sales.
- Implemented in source, deployment pending: customer verification, anonymous-user-bound tracking grants, one-order state retrieval, rate limiting, and automatic page refresh.
- Not implemented yet: private Realtime customer broadcasts, scheduled retention cleanup, and production deployment.
