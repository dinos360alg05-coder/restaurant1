# Restaurant Order Tracking System

A mobile-first order system for a single restaurant. The cashier dashboard and server function source are implemented, but those functions still need to be deployed to Supabase. Customer verification, private tracking, retention cleanup, and production hosting remain later phases.

## What is here

- `index.html`, `admin.html`, `customer.html` — responsive home, cashier, and customer tracking pages.
- `css/styles.css` — shared visual tokens, responsive layouts, accessible focus, reduced-motion support, and glass surfaces with readable fallbacks.
- `js/i18n.js` — centralized Arabic (default), French, and English strings; staff and customer preferences use separate keys. Arabic sets page direction to RTL.
- `js/config.js` — the supplied development project URL and publishable key. No server secrets belong here.
- `js/admin.js` — browser-side staff sign-in, editable cashier menu, live order cart, order queue, status controls, and receipt printing.
- `docs/database-security-design.md` — planned data model, RLS boundaries, verification, Realtime, and retention design.
- `.env.example` — placeholder names only; it is not loaded by the static pages.
- `supabase/migrations/` — ordered database migrations for schema, cashier operation, and private customer tracking; review and apply to the development project only.
- `supabase/migrations/20261024000000_staff_order_realtime.sql` — enables staff order events for Supabase Realtime.
- `supabase/functions/` — authenticated server functions for cashier operations and customer verification/tracking.
- `docs/phase2-setup.md` — database, Auth, and RLS setup status.
- `docs/phase3-setup.md` — commands to sync migrations, store the private pepper, and deploy cashier functions.

## Preview on Windows

1. Install [Git for Windows](https://git-scm.com/download/win), [Node.js LTS](https://nodejs.org/en/download), and [Visual Studio Code](https://code.visualstudio.com/). The static pages need no build step or npm packages. Node.js is only needed for the optional local web server below. After installing, open a new PowerShell window and confirm:

   ```powershell
   git --version
   node --version
   npm --version
   ```

   To open the folder in VS Code, run `code .` from the project directory. If PowerShell says `code` is not recognized, open VS Code from the Start menu and use **File → Open Folder**.
2. Open PowerShell in this project folder:

   ```powershell
   cd "$HOME\Documents\ChatGPT\restaurant QR"
   ```

3. Start the built-in local preview server with Node (no package download needed):

   ```powershell
   node .\dev-server.cjs
   ```

   Keep that VS Code terminal open while using the site. Stop the server with `Ctrl+C`. If port 4173 is already being used, choose another one:

   ```powershell
   $env:PORT = 4174
   node .\dev-server.cjs
   ```

4. Visit `http://localhost:4173`. Choose the cashier or customer page and try Arabic, French, and English. The two page types remember language separately in browser storage. This preference is not an authentication or security token.

## Supabase development project

The development project URL and publishable key supplied by the owner are configured in `js/config.js`. The owner reports that the initial schema, cashier setup, Auth options, and staff authorization have been applied. Apply the customer-tracking migration and deploy its functions using `docs/phase3-setup.md`. Never put a Supabase secret key, access-code pepper, or private key in frontend files. Put server secrets in Supabase Edge Function secrets.

`config.js` is a static file, so `.env.example` values are documentation only; ordinary HTML/JavaScript does not read `.env`. Do not commit real credentials. Keep the Supabase Auth redirect allow-list restricted to actual local and deployed URLs when Auth is configured.

## Development sequence

1. **Phase 2:** completed for development setup. The owner reports Auth settings, staff membership, and SQL simulations of staff/non-staff/anonymous RLS checks are complete. See `docs/phase2-setup.md`.
2. **Phase 3:** implemented in source: staff sign-in, editable menu with photo upload, customer and table details, server-verified order totals, status actions, preparation estimates, Realtime queue updates, and printable receipts. Apply the cashier and menu-photo migrations, then redeploy `create-order` as described in `docs/phase3-setup.md`.
3. **Phase 4:** implemented in source: private customer verification, anonymous-user-bound tracking grants, server-side rate limiting, session-scoped token storage, and automatic status refresh. Apply the customer migration and deploy `verify-order` and `get-tracking` as described in `docs/phase3-setup.md`.
4. **Phase 5:** add grant-scoped private Realtime updates. Customer status currently refreshes by polling the authorized Edge Function.
5. **Phase 6:** configure and verify scheduled 30-day cleanup, then harden and test security boundaries.
6. **Phase 7:** deploy static files to Cloudflare Pages, configure production separately, test on a phone using HTTPS, and generate the permanent QR only from the final deployment URL. Use the free `pages.dev` URL during development; choose a custom domain before printing permanent signage.

Docker is not required for the planned default workflow. Use the Supabase CLI against hosted development and production projects; local Supabase/Docker can be considered later if a concrete need arises.

## Current status

The Arabic/French/English page foundations are implemented. The owner reports that the initial migration, Auth configuration, staff authorization row, SQL simulations of the staff/non-staff/anonymous RLS boundary, cashier order creation, and staff status updates are complete. Customer tracking code and its migration are present locally and require applying the migration and deploying the two customer functions. Scheduled cleanup and Cloudflare Pages deployment remain future work.
