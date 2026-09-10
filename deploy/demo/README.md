# Hotel PMS Demo — deployment runbook (app.infinitytechub.com)

The permanent sales demo: the same shipped application as production, on the
same VPS, with its own user, directory, service, port, Supabase project and
secrets. **Nothing here touches production.**

| | Production | Demo |
|---|---|---|
| Directory | `/opt/infinity-pms` | `/opt/infinity-pms-demo` |
| User | `pms` | `pms-demo` |
| Service | `infinity-pms.service` | `infinity-pms-demo.service` |
| Port | 3100 | 3200 |
| Env file | `.env.production` | `.env.demo` |
| Supabase | `texhuavnrdhaohqzlyqw` | `akcppyymgoubsqedpkch` |
| Host | theskwoffhotel.com | app.infinitytechub.com |

Both run under **systemd**. Neither uses PM2. A demo restart cannot restart
production and vice versa — different units, different users, different
`ReadWritePaths`.

---

## Access model — read this before running anything

**Root SSH is disabled on this host and must stay that way.**
`/etc/ssh/sshd_config.d/00-hardening.conf` sets `PermitRootLogin no`, and the
`Include` on line 12 of `sshd_config` means it wins over the stock directive
further down. `PasswordAuthentication` is `no` as well. A direct
`ssh root@…` returns `Permission denied (publickey)`.

There are two human accounts on the box:

| Account | UID | Sudo | Purpose |
|---|---|---|---|
| `deploy` | 1000 | member of `sudo` — full | **the administrator account; run this runbook as it** |
| `claude-deploy` | 1001 | four exact commands only | the automation account |

`claude-deploy`'s `NOPASSWD` sudo covers only
`systemctl {restart,status,is-active} pm2-infinitysales`, some `pm2` commands
for that unrelated app, `nginx -t`, and `/usr/local/sbin/deploy-infinity-pms`.
It deliberately cannot create users, write into `/opt`, install systemd units,
edit nginx or run certbot. **Do not broaden it to make this convenient** —
that scope is what keeps the automated production deploy path narrow. Run the
one-time provisioning as `deploy` instead, which is exactly what that account
is for.

Every command below therefore uses `deploy@187.127.234.113` with `sudo`, and
prompts for the sudo password interactively. If the `deploy` key is not on
your workstation, use the Hostinger hPanel **Browser terminal** for the same
commands (see the end of this file).

---

## A. DNS

### This hostname is being taken over, deliberately

`app.infinitytechub.com` resolves today to **185.158.133.1**, a **Cloudflare**
edge address (`Server: cloudflare`, `CF-RAY`, `__cf_bm`), serving a
Cloudflare-hosted build of *Infinity Mart Sales Management 360*. It has nothing
to do with this VPS — no nginx block here answers for any `infinitytechub`
hostname.

**The owner has decided the PMS demo takes this hostname.** Sales 360 is being
replaced *at this name only*. Nothing of it is deleted: its application, files
and database are untouched, and the VPS-hosted build of the same product stays
live and unaffected at **`infinitytechapp.com`** (separate nginx block,
separate port 3000, pm2-managed — none of which this runbook touches).

### The record

The zone is on **Hostinger** DNS (`solar.dns-parking.com` /
`lunar.dns-parking.com`), so edit it in **hPanel → Domains → DNS / Nameservers**.

The `app` host has **exactly one record** — a single `A`, TTL 14400, value
`185.158.133.1`. There is **no `AAAA`, no `CNAME` and no `TXT`**, so nothing
needs deleting: change that one record's value.

| Field | Value |
|---|---|
| **Type** | `A` |
| **Host / Name** | `app` |
| **Points to / Value** | `187.127.234.113` |
| **TTL** | `300` (raise to 3600 once verified) |

**Propagation.** The current record's TTL is **14400 (4 hours)**, so resolvers
that have already cached `185.158.133.1` may keep serving it for up to that
long. During the overlap some visitors reach the old Sales 360 build and others
reach the demo. The demo is not live yet, so nothing of ours is "down" — but
**certbot must wait** until Let's Encrypt's validators see `187.127.234.113`,
or the HTTP-01 challenge fails. Lowering the TTL to 300 in the same edit makes
every future change quick.

**Why 187.127.234.113.** That is the VPS's own public address, held directly on
`eth0` with no NAT and no CDN in front of it. It is confirmed independently by
production: `theskwoffhotel.com` resolves to it and is served from this host by
plain nginx, with no Cloudflare in the path. `infinitytechapp.com` resolves to
it too. The demo will be served the same way — directly from this VPS — so the
A record must name the origin, not a proxy.

Change nothing else. Leave the apex `infinitytechub.com` (Hostinger shared
hosting, and it rotates between addresses), everything under
`theskwoffhotel.com`, and the `infinitytechapp.com` record that keeps Sales 360
reachable, all exactly as they are.

Confirm before continuing:

```bash
dig +short app.infinitytechub.com      # must print 187.127.234.113, nothing else
```

Certbot cannot issue until this resolves here, so do not start section E early.

## B. One-time VPS provisioning

```bash
scp deploy/demo/provision-demo.sh deploy@187.127.234.113:/tmp/provision-demo.sh
ssh deploy@187.127.234.113 'sudo bash /tmp/provision-demo.sh'
```

It records production's PID and SHA before it starts and re-checks them at the
end, aborts if port 3200 is occupied rather than killing anything, refuses if
the env file names the production project, and refuses to install a bundle
containing the production Supabase ref. Re-running it is safe, and it is also
the demo's future update path.

On first run it stops and asks for the env file. That is section C.

## C. Demo environment file

```bash
scp .env.demo deploy@187.127.234.113:/tmp/.env.demo
ssh deploy@187.127.234.113 '
  sudo install -o pms-demo -g pms-demo -m 600 /tmp/.env.demo /opt/infinity-pms-demo/.env.demo
  shred -u /tmp/.env.demo'
ssh deploy@187.127.234.113 'sudo bash /tmp/provision-demo.sh'
```

`install` sets owner and mode in one step, so the file is never briefly
world-readable in `/opt`, and `shred -u` removes the staging copy. No secret
appears on any command line, so none reaches shell history.

The file carries demo-only values: demo Supabase URL, publishable key and
service-role key, a demo-specific `PAYROLL_FIELD_ENCRYPTION_KEY`, a demo
`CRON_SECRET`, and **every external integration key left empty** — no email,
cloud printing, virus scanning, AI or Booking.com webhook secret. No production
credential appears in it, and no server secret carries a `VITE_` prefix.
**Never commit it.**

## D. Nginx

```bash
scp deploy/demo/nginx-app.infinitytechub.com.conf \
    deploy@187.127.234.113:/tmp/infinity-pms-demo.conf
ssh deploy@187.127.234.113 '
  sudo install -m 644 /tmp/infinity-pms-demo.conf /etc/nginx/sites-available/infinity-pms-demo
  sudo ln -sfn /etc/nginx/sites-available/infinity-pms-demo /etc/nginx/sites-enabled/infinity-pms-demo
  sudo nginx -t && sudo systemctl reload nginx'
```

Install the HTTP-only block first and let certbot add TLS — writing
`ssl_certificate` paths before the certificate exists makes `nginx -t` fail.
**Only reload after `nginx -t` passes.** The block names one host and one
upstream, and no existing block claims `app.infinitytechub.com`, so no other
site's routing changes.

Then confirm both hosts still route where they should:

```bash
ssh deploy@187.127.234.113 "curl -s -o /dev/null -w 'demo via nginx: %{http_code}\n' -H 'Host: app.infinitytechub.com' http://127.0.0.1/api/public/health"
curl -s -o /dev/null -w 'production: %{http_code}\n' https://theskwoffhotel.com/api/public/health
```

## E. TLS

```bash
ssh deploy@187.127.234.113 'sudo certbot --nginx -d app.infinitytechub.com'
```

One domain, named explicitly — do not use `--expand` and do not let it pick up
other server names. Certbot rewrites this block only, adds the port-80 → 443
redirect, and registers renewal. Verify:

```bash
ssh deploy@187.127.234.113 'sudo certbot certificates | grep -A3 app.infinitytechub.com
                            systemctl list-timers | grep -i certbot'
curl -sI http://app.infinitytechub.com | head -1      # expect 301
curl -s https://app.infinitytechub.com/api/public/health
```

## F. Supabase Auth — dashboard only

**Never run `supabase config push` against the demo project.** It has disabled
the email provider twice: CLI 2.107 does not recognise `auth.email.enabled`,
yet `config push` writes `external_email_enabled=false` and every login breaks.
Auth for this project is dashboard-managed.

In the dashboard for `akcppyymgoubsqedpkch`, under **Authentication → URL
Configuration**, visually confirm:

- **Site URL** — `https://app.infinitytechub.com`
- **Redirect URLs** — contains `https://app.infinitytechub.com/reset-password`,
  and no other entry

Under **Authentication → Providers / Sign In**, these were already verified
read-only via `/auth/v1/settings` and should need no change: email provider
**on**, public signup **off**, phone **off**, anonymous **off**, no OAuth
provider enabled.

---

## Verification after the above

```bash
ssh deploy@187.127.234.113 'systemctl is-active infinity-pms-demo infinity-pms
                            systemctl is-enabled infinity-pms-demo infinity-pms'
curl -s https://app.infinitytechub.com/api/public/health
curl -s https://theskwoffhotel.com/api/public/health
```

Both services must report `active` and `enabled` — `enabled` is what makes them
come back after a reboot, which is why the unit carries
`WantedBy=multi-user.target`. Do not reboot this shared host to test that.

### Proving the demo really talks to the demo database

`/api/public/health` deliberately reveals no project identifier — it returns
only booleans, timings and versions, which is correct for a public endpoint.
So verify identity from the served bundle instead. `VITE_SUPABASE_URL` is
inlined at build time, so the demo's own JavaScript names its project:

```bash
# must print exactly akcppyymgoubsqedpkch.supabase.co
# printing NOTHING is the failure this catches: it means the VITE_ values were
# never inlined and every page will hit the error boundary in the browser.
curl -s https://app.infinitytechub.com/auth \
  | grep -aoE '/assets/[A-Za-z0-9._-]+\.js' | sort -u \
  | while read -r a; do curl -s "https://app.infinitytechub.com$a"; done \
  | grep -aoE '[a-z0-9]{15,25}\.supabase\.co' | sort -u
```

Assets are served from `/assets/`, not `/_build/assets/` — an earlier revision
of this file had the wrong path, so the check silently matched nothing and
looked like it had passed. The provisioning script now asserts the same thing
at build time and **fails** rather than warning.

A faster equivalent, once signed in: the demo shows **Infinity Grand Hotel**
with GHS amounts and an Africa/Accra clock, and the demo database contains no
ThesKwoff row at all — `system_settings`, `property_branding` and `properties`
were checked and hold zero mentions.

## If you do not have the `deploy` SSH key to hand

Use the Hostinger hPanel **Browser terminal** (VPS → Manage → Browser terminal),
which opens a root session on the console without enabling root over SSH. Run
the same commands there, dropping the `ssh …` wrapper and the `sudo` prefix,
and upload the two files through hPanel's file manager instead of `scp`:

```bash
bash /tmp/provision-demo.sh
install -o pms-demo -g pms-demo -m 600 /tmp/.env.demo /opt/infinity-pms-demo/.env.demo && shred -u /tmp/.env.demo
install -m 644 /tmp/infinity-pms-demo.conf /etc/nginx/sites-available/infinity-pms-demo
ln -sfn /etc/nginx/sites-available/infinity-pms-demo /etc/nginx/sites-enabled/infinity-pms-demo
nginx -t && systemctl reload nginx
certbot --nginx -d app.infinitytechub.com
```

Prefer the `deploy` account over the console when you have the key: it leaves a
normal audit trail through `sudo`, and it does not require a root console
session at all.

## Updating the demo later

```bash
ssh deploy@187.127.234.113 'sudo bash /tmp/provision-demo.sh'
```

Same script. It fast-forwards to `origin/main`, rebuilds, restarts the demo
service, and re-checks that production's PID and SHA are unchanged.

## Rolling the demo back or taking it down

```bash
ssh deploy@187.127.234.113 'sudo systemctl stop infinity-pms-demo'     # demo offline, production unaffected
ssh deploy@187.127.234.113 'sudo systemctl disable infinity-pms-demo'  # and stays down across reboots
```
