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

## Why these steps need you

The `claude-deploy` SSH user has `NOPASSWD` sudo for exactly four commands:
restart/status/is-active of an unrelated `pm2-infinitysales` service, `nginx -t`,
and `/usr/local/sbin/deploy-infinity-pms`. That is deliberately narrow, and it
is the right design — it means the deploy automation cannot create users, write
systemd units, edit nginx or obtain certificates. Steps 1–6 below therefore need
a root shell. Everything after them can be verified without one.

---

## 1. DNS  *(do this first — certbot needs it resolving)*

`app.infinitytechub.com` currently resolves to **185.158.133.1**, which is not
this VPS. Create or update:

| Type | Name | Value | TTL |
|---|---|---|---|
| `A` | `app` | `187.127.234.113` | 300 (raise later) |

- Change **only** the `app` record. Leave the apex `infinitytechub.com`
  (`88.222.222.129` / `84.32.84.98`) exactly as it is, and never touch
  `theskwoffhotel.com`.
- If an `AAAA` record exists for `app`, delete it or point it at this host's
  IPv6 address — a stale `AAAA` will win on IPv6 clients and silently bypass
  the demo.

Confirm before continuing:

```bash
dig +short app.infinitytechub.com     # must print 187.127.234.113
```

## 2. Provision

```bash
scp deploy/demo/provision-demo.sh root@srv1760881:/root/
ssh root@srv1760881 'bash /root/provision-demo.sh'
```

It records production's PID and SHA before it starts and re-checks them at the
end, aborts if port 3200 is occupied rather than killing anything, refuses if
the env file names the production project, and refuses to install a bundle
containing the production Supabase ref. Re-running it is safe.

On first run it will stop and ask for the env file. That is step 3.

## 3. Environment file

Copy the prepared `.env.demo` to `/opt/infinity-pms-demo/.env.demo`, then
re-run the provisioning script.

```bash
scp .env.demo root@srv1760881:/opt/infinity-pms-demo/.env.demo
ssh root@srv1760881 'chown pms-demo:pms-demo /opt/infinity-pms-demo/.env.demo && chmod 600 /opt/infinity-pms-demo/.env.demo'
```

It carries demo-only values throughout: the demo Supabase URL, publishable key
and service-role key, a demo-specific `PAYROLL_FIELD_ENCRYPTION_KEY`, a demo
`CRON_SECRET`, and **every external integration key left empty** — no email, no
cloud printing, no virus scanning, no AI, no Booking.com webhook secret. No
production credential appears in it, and no server secret carries a `VITE_`
prefix. Never commit it.

## 4. Nginx

```bash
scp deploy/demo/nginx-app.infinitytechub.com.conf \
    root@srv1760881:/etc/nginx/sites-available/infinity-pms-demo
ssh root@srv1760881 '
  ln -sfn /etc/nginx/sites-available/infinity-pms-demo /etc/nginx/sites-enabled/infinity-pms-demo
  nginx -t && systemctl reload nginx'
```

Install the HTTP-only block first and let certbot add TLS — writing
`ssl_certificate` paths before the certificate exists makes `nginx -t` fail.
**Only reload after `nginx -t` passes.** The block names one host and one
upstream, so no existing site's routing changes.

Then confirm both hosts still route where they should:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: app.infinitytechub.com' http://127.0.0.1/api/public/health
curl -s -o /dev/null -w '%{http_code}\n' https://theskwoffhotel.com/api/public/health
```

## 5. TLS

```bash
ssh root@srv1760881 'certbot --nginx -d app.infinitytechub.com'
```

One domain, named explicitly — do not use `--expand` and do not let it pick up
other server names. Certbot rewrites this block only, adds the port-80 → 443
redirect, and registers renewal. Verify:

```bash
ssh root@srv1760881 'certbot certificates | grep -A3 app.infinitytechub.com; systemctl list-timers | grep -i certbot'
curl -sI http://app.infinitytechub.com | head -1     # expect 301
curl -s https://app.infinitytechub.com/api/public/health
```

## 6. Supabase Auth — dashboard only

**Never run `supabase config push` against the demo project.** It has disabled
the email provider twice: CLI 2.107 does not recognise `auth.email.enabled`,
yet `config push` writes `external_email_enabled=false` and every login breaks.
Auth for this project is dashboard-managed.

Confirm in the dashboard for `akcppyymgoubsqedpkch`, under **Authentication →
URL Configuration**:

- **Site URL** — `https://app.infinitytechub.com`
- **Redirect URLs** — `https://app.infinitytechub.com/reset-password`, and
  remove any other entry

The remaining settings are already correct and were verified read-only via
`/auth/v1/settings`: email provider **on**, public signup **off**, phone
**off**, anonymous **off**, no OAuth provider enabled.

---

## Verification after the above

```bash
ssh root@srv1760881 'systemctl is-active infinity-pms-demo infinity-pms; systemctl is-enabled infinity-pms-demo infinity-pms'
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
# must print akcppyymgoubsqedpkch, and must NOT print texhuavnrdhaohqzlyqw
curl -s https://app.infinitytechub.com/ \
  | grep -oE '/_build/assets/[A-Za-z0-9._-]+\.js' | sort -u | head -20 \
  | while read -r a; do curl -s "https://app.infinitytechub.com$a"; done \
  | grep -oE '[a-z]{20}\.supabase\.co' | sort -u
```

A faster equivalent, once signed in: the demo shows **Infinity Grand Hotel**
with GHS amounts and an Africa/Accra clock, and the demo database contains no
ThesKwoff row at all — `system_settings`, `property_branding` and `properties`
were checked and hold zero mentions.

## Updating the demo later

```bash
ssh root@srv1760881 'bash /root/provision-demo.sh'
```

Same script. It fast-forwards to `origin/main`, rebuilds, restarts the demo
service, and re-checks that production's PID and SHA are unchanged.

## Rolling the demo back or taking it down

```bash
systemctl stop infinity-pms-demo     # demo offline, production unaffected
systemctl disable infinity-pms-demo  # and stays down across reboots
```
