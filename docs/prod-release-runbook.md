# Production Release Runbook — Infinity PMS (ThesKwoff Hotel)

This describes the guarded automation under `scripts/prod/` that lets an
approved release be applied to production (migration, deploy, health,
authenticated UI smoke) without hand-carrying SQL/VPS/UI steps back and
forth. Every script fails closed: it validates its target before doing
anything, and refuses on any mismatch.

## Known VPS findings (discovered during the 2026-08-21 read-only rehearsal)

- **The VPS (`srv1760881` / `187.127.234.113`) is shared with at least one
  other project**, which explains a finding from the first rehearsal: a
  direct loopback request to `http://127.0.0.1:3000/api/public/health`
  returned HTTP 501 with a body claiming the endpoint "has not been migrated
  to Lovable Cloud yet" — a string that doesn't appear anywhere in this
  repo's build. **Root cause, confirmed:** port 3000 belongs to a different
  app on this shared box (`/etc/nginx/sites-enabled/infinitysales`,
  `server_name infinitytechapp.com`, also proxying to `127.0.0.1:3000`) —
  the 501 response was that *other* app answering, not a routing quirk.
  **Hotel PMS's own service actually listens on `127.0.0.1:3100`**
  (`production.config.json`'s `vps_local_health_port`). With the correct
  port, the local health check is authoritative and fatal again in both
  `vps-precheck.mjs` and `vps-deploy.mjs` — there is deliberately no
  fallback default port, so a future misconfiguration can't silently probe
  the wrong app again.
- `claude-deploy` correctly cannot read `/opt/infinity-pms/.env.production`
  (permission denied) — this is expected and correct (the file should stay
  `pms`-only), not a bug.
- `systemctl is-active infinity-pms` **does** work for `claude-deploy`
  without sudo on this box, confirming the non-sudo status-query assumption
  in `lib/vps.mjs` holds here.

## One-time human setup

These steps only need to happen once (or once per credential rotation).
None of them are performed by Claude — they require a human with the actual
production access.

### 1. Confirm the production identity

Open `scripts/prod/production.config.json`. Verify, by actually looking at
the Supabase dashboard and visiting the production domain yourself:

- `supabase_project_ref` really is the live production tenant's project ref
  — **not** the "Demo Hotel" project or any staging copy. (`supabase
  projects list` shows every project this account can see; match by name
  and by opening it in the dashboard, not by ref alone.)
- `production_domain` really is the live public URL.

Then edit `human_confirmation`:

```json
"human_confirmation": {
  "confirmed": true,
  "confirmed_by": "your name",
  "confirmed_at": "2026-08-21"
}
```

No write-path script will run until this is `true`. Flip it back to
`false` immediately if the ref, domain, VPS path, or service name ever
change (e.g. a project migration), and repeat this confirmation.

### 2. SSH host alias (confirmed setup, 2026-08-21)

`hotel-pms-vps` is already configured in `~/.ssh/config`, using the
existing `claude-deploy` user and `C:\Users\wwmit\.ssh\claude_infinity_deploy`
key. **Note for whoever maintains this next:** this VPS
(`srv1760881` / `187.127.234.113`) is shared with another project (see
"Known VPS findings" above), and this same key/user is also used by that
other project's `claude-infinity` SSH alias — the isolation between the two
projects' automation is enforced at the **sudoers** layer (each project's
`claude-deploy`-equivalent access is scoped to its own single wrapper
command, not by having separate SSH keys), not at the transport layer. If
you ever split these onto separate keys/users, update
`ssh_host_alias`/`vps_ssh_user` in `production.config.json` together, and
re-run `human_confirmation`.
`PermitRootLogin no` and Fail2Ban remain enabled on the VPS.

### 3. Supabase CLI authentication

Run `supabase login` once in your own shell (stores a token in the CLI's
own config, outside this repo). Every guarded script relies on this
already-authenticated CLI session — none of them hold or accept a Supabase
access token themselves.

### 4. Production database connection string

Get the connection string from the Supabase dashboard for project
`texhuavnrdhaohqzlyqw` ("Theskwoff Hotel"): **Project Settings → Database →
Connection string** (URI form). **Never paste it into a chat/prompt, never
write it to a file in this repo or anywhere under version control, and
avoid it landing in shell history.**

Recommended: create it once, outside the repo, with an editor (not `echo`,
which can leave the secret in shell history):

```bash
nano ~/.secrets/hotel-pms-prod-db-url.sh
# contents: export PROD_SUPABASE_DB_URL="postgresql://postgres:...@db.texhuavnrdhaohqzlyqw.supabase.co:5432/postgres"
chmod 600 ~/.secrets/hotel-pms-prod-db-url.sh
```

Then, each session before running a Supabase read-only or write-path
script:

```bash
source ~/.secrets/hotel-pms-prod-db-url.sh
```

**How the toolkit protects this once it's set:**
- `resolveProductionDbUrl()` (`scripts/prod/lib/guard.mjs`) parses the ref
  out of the URL's hostname/username and compares it to
  `production.config.json`'s `supabase_project_ref` — a wrong/pasted-from-
  another-project connection string is caught before any query or push
  runs, not after.
- Every log line and error message that could involve the URL uses
  `maskConnectionString()` (password replaced with `***`) or only echoes
  the already-extracted, non-secret ref — never the raw string. Verified by
  `tests/prod-guards.test.ts`'s `resolveProductionDbUrl`/`maskConnectionString`
  suites (unit tests, no real credential needed to run them).
- `release-report.mjs` redacts anything shaped like a connection string as
  a final defense-in-depth pass before writing `report.md`, on top of the
  fact that nothing upstream ever prints the raw value into a stage log in
  the first place.
- The value only ever exists as a process environment variable and as an
  `execFile` argument to the `supabase` CLI child process — it is never
  written to disk by this toolkit.

You can self-check the masking/validation without touching production:
```bash
node -e "
import('./scripts/prod/lib/guard.mjs').then(g => {
  process.env.PROD_SUPABASE_DB_URL = 'postgresql://postgres:fake@db.texhuavnrdhaohqzlyqw.supabase.co:5432/postgres';
  const { masked } = g.resolveProductionDbUrl(g.loadProductionConfig());
  console.log(masked); // should print '***' in place of 'fake'
});
"
```

### 5. Authenticated UI-smoke session (never store a password)

Run this **exact command** (verified against the Playwright version pinned
in this repo, 1.61.1) to open a real browser against production and save
your session on close — nothing else needed, no test code generated:

```bash
npx playwright open --save-storage=$HOME/.secrets/hotel-pms-prod-state.json https://theskwoffhotel.com
```

1. A Chromium window opens on the real production site. Sign in yourself,
   manually, as an account with the roles you need for the smoke checks
   you intend to run.
2. Close the browser window. Playwright writes the session (cookies +
   localStorage) to the `--save-storage` path at that point — nothing is
   saved until you close it.
3. That path (`~/.secrets/hotel-pms-prod-state.json` above, or wherever you
   choose) must be **outside this repository** — never inside the repo,
   never committed, never in `.env`. It is gitignored by location, not by a
   repo rule, since it should never be created inside the repo in the first
   place; if you ever do put it somewhere under this repo by mistake, add
   it to `.gitignore` immediately and rotate the session (sign out
   elsewhere, sign back in, re-export).
4. Point `PROD_SMOKE_STORAGE_STATE` at it before running `ui-smoke.mjs`:
   ```bash
   export PROD_SMOKE_STORAGE_STATE=$HOME/.secrets/hotel-pms-prod-state.json
   ```

If `ui-smoke.mjs` reports the session has expired (redirected to `/auth`),
repeat steps 1–2 and re-export. It will never attempt to log in with a
stored username/password, because none is ever stored.

### 6. Demo/dry-run parser rehearsal — done (2026-08-21)

`scripts/prod/supabase-migrate.mjs` parses `supabase db push --dry-run`'s
text output to confirm exactly one migration is pending before it will
apply anything. The plan was to rehearse this against the non-production
"Demo Hotel" project — but that requires a database password for that
project, which nobody had supplied and which this toolkit deliberately
never asks a human to paste into chat (the same policy that protects the
production password). Instead, the parser was verified against the **real
Supabase CLI** (v2.107.0) using a local disposable stack (`supabase start`
in this repo, a migration file temporarily held out of `supabase/migrations/`
then restored, `supabase db reset`, then real `db push --dry-run` /
`db push` calls against `postgresql://postgres:postgres@127.0.0.1:54322/postgres`
— Supabase's well-known, non-secret local dev default). The CLI's output
format doesn't vary between a local and a cloud target, so this is a
genuine verification of the parser against real CLI behavior, not a
simulation. Two real findings came out of it and were fixed:

1. **Exactly-one-pending output** renders as:
   ```
   DRY RUN: migrations will *not* be pushed to the database.
   Connecting to local database...
   Would push these migrations:
    • 20260821120000_ar_credit_note_receipt_reversal.sql
   Finished supabase db push.
   ```
   The parser's regex already matched this correctly — no change needed.
2. **Nothing-pending output** renders as `Local database is up to date.`
   (no filename at all). The parser previously lumped this into a generic
   "could not parse" error; it now detects this case specifically and
   raises a clearer message ("already up to date... it may already have
   been applied").
3. **A real bug, unrelated to parsing:** the actual apply call, `supabase
   db push --db-url <url>` (no flags), renders an **interactive `[Y/n]`
   confirmation** — which would hang forever in this script's non-TTY child
   process. Fixed by adding the Supabase CLI's own `--yes` flag to that one
   call (distinct from, and layered on top of, this script's own `--yes`
   gate, which is checked well before the CLI is ever invoked).

If the local stack was left running by an interrupted rehearsal, `supabase
stop` cleans it up; this repo's local Postgres is disposable and unrelated
to production.

## Creating a release plan

Copy `scripts/prod/release-plan.example.json` to
`scripts/prod/releases/<date>-<slug>.json` and fill in every field for the
specific, already-reviewed release:

- `approved_git_sha` — the exact commit you're releasing (e.g. the squash
  merge commit of the reviewed PR).
- `migration` — the migration's repo-relative path and its SHA256 computed
  from the **pristine git blob** at that commit:
  ```bash
  git show <approved_git_sha>:supabase/migrations/<file>.sql | sha256sum
  ```
  Omit (`null`) if the release has no new migration.
- `preflight_sql` / `postflight_sql` — paths to read-only SQL files (see
  `supabase/preflight/` for the existing convention; add a matching
  `supabase/postflight/<name>.sql` for this release's expected end-state
  checks).
- `ui_smoke.tags` — normally just `["@prod-readonly"]`. Only add
  `@prod-write` / `@prod-financial` with the matching `authorize_*_tests:
  true` when this specific release's plan has been reviewed and explicitly
  calls for it.

## Running a release

```bash
# Rehearsal: every check runs, nothing is mutated. Stops right before the
# first real write (migration apply), reporting what would happen next.
scripts/prod-release.sh scripts/prod/releases/2026-08-21-example.json

# Real run: performs the actual migration apply and VPS deploy.
scripts/prod-release.sh scripts/prod/releases/2026-08-21-example.json --yes
```

Each stage stops the whole run on failure (`set -e` plus explicit stage
gating) — no later stage executes once an earlier one fails. A report is
written to `scripts/prod/releases/<release_id>/<timestamp>/report.md` (and
printed to stdout) either way.

## Extending UI smoke coverage

- Read-only route coverage lives in `scripts/prod/ui-routes.mjs` — add a
  route + `@prod-readonly` tag there for anything not yet covered (e.g. a
  specific folio detail page or the AR customer-statement dialog, both of
  which need a real record id and so aren't in the default bare-navigation
  list yet).
- Write/financial scenarios live in `scripts/prod/ui-scenarios/`. The
  shipped `ar-invoice-financial.mjs` is the one worked reference
  implementation for the required pattern: create a clearly-marked smoke
  record, exercise the real create → post → reverse workflow, never delete
  anything, and report exactly what was created and how it was reconciled.
  Follow that same shape for AP, credit notes/receipts, POS, etc. — a
  release plan only runs a scenario if you wire it into `ui-smoke.mjs` and
  the plan authorizes its tag.

## What this toolkit deliberately does not do

- It never deletes financial history. Reversal/void RPCs are the only
  supported "undo" — see the AR credit-note/receipt reversal work
  (`supabase/migrations/20260821120000_ar_credit_note_receipt_reversal.sql`)
  for the pattern every write scenario should follow.
- It never accepts inline SQL as "the migration" — only a file already
  committed to git, hash-checked against the approved commit.
- It never stores a production password, service-role key, or connection
  string in this repository.
- It never widens Claude Code's global `autoMode` permissions — see the
  companion report for the exact, narrow, project-scoped permission rules
  proposed for this toolkit.
