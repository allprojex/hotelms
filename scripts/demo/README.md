# Demo environment seeder

Builds the sales-demonstration copy of the PMS: **Infinity Grand Hotel**, a
fictional 43-room hotel in Accra trading in GHS, on its own Supabase project and
its own host (`https://app.infinitytechub.com`). Same code, same modules, same
migrations as production — only the environment and the data differ.

Nothing here may ever run against production. The target is an explicit
allowlist (`akcppyymgoubsqedpkch`) with the production ref
(`texhuavnrdhaohqzlyqw`) on an explicit denylist, and **every request URL** is
checked against both, not just the startup configuration
(`scripts/demo/lib/env.mjs`).

## Running it

```bash
# required environment — no secret is ever committed
export DEMO_SUPABASE_URL=https://akcppyymgoubsqedpkch.supabase.co
export DEMO_SUPABASE_ANON_KEY=...
export DEMO_SUPABASE_SERVICE_ROLE_KEY=...
export DEMO_PROPERTY_ID=8472dfd0-356a-49e2-8dcf-da227a148cc4
export DEMO_ADMIN_EMAIL=...          # the bootstrap demo administrator
export DEMO_ADMIN_PASSWORD=...
export DEMO_CREDENTIAL_FILE=~/.secrets/infinity-pms-demo-staff.txt

node scripts/demo/seed-demo.mjs --dry-run          # show what each stage would do
node scripts/demo/seed-demo.mjs                    # everything, in order
node scripts/demo/seed-demo.mjs --only=catalog,pos # selected stages
node scripts/demo/seed-demo.mjs --as-of=2026-09-09 # anchor the business date
node scripts/demo/verify-demo.mjs                  # cross-module consistency checks
```

## How the data gets written

Two rules decide how every row is created.

**Business data is written as a signed-in user, never with the service role.**
The application's posting logic authorises on `auth.uid()` and
`has_any_role()` — `post_payment`, `post_reservation_checkout`, `post_journal`,
every `expense_*` and `payroll_*` RPC. A service-role write has no `auth.uid()`,
so it is either refused or, worse, silently skips the accounting side effect and
leaves the demo internally inconsistent. The service key is used only for the
Auth Admin API (creating accounts, exactly as `createManagedAccount` does) and
for read-only verification.

**The work is done by the role that would really do it**, which is also how the
demo shows sensible "created by" attribution:

| Who | Does |
| --- | --- |
| reservations officer / front desk | guests, bookings, folio charges, check-ins |
| cashier | POS orders and items, guest payments |
| general manager | POS closing (posts F&B revenue), purchase orders, receiving, adjustments, night audit, checkouts |
| accountant | supplier bills and payments, corporate invoices and receipts, expenses |
| HR manager | departments, employees, roster, attendance, leave |
| each employee | their own leave requests (RLS requires `created_by = auth.uid()`) |

Two of those are not stylistic. `post_journal()` accepts only
super_admin/hotel_owner/general_manager/accountant, so **a front-desk checkout
or a cashier's POS close posts no journal at all** — silently, because
`post_reservation_checkout()` and `post_pos_order_close()` swallow the
authorisation error. The seeder performs those two steps as the general
manager; the underlying defect is reported separately.

## Stages

| Stage | What it creates |
| --- | --- |
| `users` | ten staff accounts and their roles, through the `createManagedAccount` sequence |
| `property` | room types, 43 rooms, rate plans, cost centres, expense categories, monthly financial periods |
| `catalog` | stock locations, suppliers, ~52 inventory items with opening stock and expiry batches, three POS outlets, tables, menus |
| `operations` | the day-by-day trading history: guests, reservations, arrivals, POS trade, payments, stock consumption, room and housekeeping state |
| `nightaudit` | closes every past business date — checkouts (which post the folio journals) and no-shows |
| `accounting` | weekly purchase orders → receiving → supplier bills → payments, stock adjustments and a transfer, expenses through the full approval workflow with generated receipt PDFs, corporate invoices and receipts |
| `hrm` | 11 departments, 24 designations, 48 employees, shifts, duty roster, attendance (via the biometric import path), leave balances and requests, announcements |
| `payroll` | pay frequency, calendar, components and rules, statutory rules, salary structure and grades, employee compensation, and the draft runs |
| `gallery` | albums and generated placeholder images for every room type and facility, with room-type covers |

`operations` and `accounting` refuse to run twice without
`--allow-transactional-rerun`, so a partial rerun cannot silently double the
demo's revenue. Every configuration stage is safely rerunnable.

## Payroll: why the seeder stops at the draft run

The payroll engine lives in the application
(`src/lib/hrm/payroll-calculation.ts`, driven by the `calculateDraftPayrollRun`
server function). The database only stores what the application computes,
through `payroll_store_calculation_results()`. Writing results any other way
produces payslips that change the moment anyone presses Recalculate — so this
seeder never does.

To calculate a run, drive the running application:

1. Start the demo build with the demo environment (`node .output/server/index.mjs`).
2. Sign in as the demo administrator.
3. Payroll → Payroll Processing → Draft Payroll Runs → open the run → Calculate.
4. Then `node scripts/demo/payroll-lifecycle.mjs`, which takes every calculated
   run through acknowledge-warnings → lock → submit → approve → finalise →
   generate and publish payslips, using the application's own RPCs.

Steps 2–3 currently require the routing defect in the payroll section to be
fixed first (see the defect report); until then the calculation can be invoked
through the same server function the page would call.

## Fictional data only

Every guest, employee, supplier and corporate customer is invented in
`lib/random.mjs`. Contact details use RFC 2606 reserved space (`.example`,
`.invalid`) and the non-assignable `+233 30 000 xxxx` block, so nothing here can
reach a real mailbox or telephone. Receipts and gallery images are generated
(`lib/receipt-pdf.mjs`, `lib/placeholder-image.mjs`) — no production document or
photograph is ever copied.
