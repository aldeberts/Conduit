# Deploying Conduit on a DigitalOcean Droplet

Single-user (Phase 1) hosted setup behind TLS. Once this is working you can
move to Phase 2 (per-user accounts) without touching the infra side of things.

## Prereqs

- DigitalOcean account, billing set up.
- A domain you control (e.g. `conduit.example.com`) with an A record pointing
  at the Droplet's public IPv4.
- Local machine with the repo cloned and tests green
  (`npm test` from the repo root).

## What you'll spin up

| Resource                  | Spec                      | Approx cost     |
| ------------------------- | ------------------------- | --------------- |
| Droplet (Ubuntu 24.04)    | Basic, 1 vCPU, 1-2 GB RAM | $6-12 / month   |
| Volume                    | 10 GB block storage       | ~$1 / month     |
| Domain                    | Bring your own            | --              |

## One-time Droplet setup

After the Droplet is provisioned and you can `ssh root@<ip>`:

1. **Attach the Volume.** In the DO control panel, create a 10 GB Volume in
   the same region as the Droplet and attach it. DO will give you the exact
   `mkfs` / `mount` commands to run; the canonical mount path used by the rest
   of these files is `/mnt/conduit_data`.

2. **Create the conduit user + directory layout.** SSH in as root and run:
   ```bash
   adduser --system --group --home /var/lib/conduit conduit
   mkdir -p /var/lib/conduit/{data,shadow} /var/www/conduit /etc/conduit
   ln -s /mnt/conduit_data /var/lib/conduit/data
   chown -R conduit:conduit /var/lib/conduit /var/www/conduit
   ```

3. **Install Node 20+ and Caddy.**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
   apt-get install -y nodejs
   apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
     | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
     | tee /etc/apt/sources.list.d/caddy-stable.list
   apt-get update && apt-get install -y caddy
   ```

4. **Drop in the env file.** Copy `deploy/env.example` to `/etc/conduit/env`,
   then fill in a strong random `API_TOKEN`:
   ```bash
   openssl rand -hex 32
   ```
   Edit `/etc/conduit/env` so that `API_TOKEN=...` matches.
   ```bash
   chmod 600 /etc/conduit/env
   chown conduit:conduit /etc/conduit/env
   ```

5. **Install the systemd unit + Caddyfile.** From the repo on your laptop:
   ```bash
   scp deploy/conduit.service root@<ip>:/etc/systemd/system/conduit.service
   scp deploy/Caddyfile       root@<ip>:/etc/caddy/Caddyfile
   ```
   On the Droplet:
   ```bash
   # Edit /etc/caddy/Caddyfile and replace conduit.example.com with your domain.
   systemctl daemon-reload
   systemctl enable --now caddy
   ```
   (Don't enable `conduit.service` yet -- we haven't deployed the build.)

## Deploying a build

The `deploy/update.sh` script runs **on your laptop** and pushes a fresh
build to the Droplet. Run it from the repo root:

```bash
DROPLET_HOST=root@your.droplet.ip ./deploy/update.sh
```

It will:
1. Run `npm ci` + `npm run build` locally (so failures don't reach prod).
2. `rsync` `services/middleman/dist`, `services/middleman/package.json`,
   `services/middleman/node_modules`, `packages/shared/dist`,
   `packages/shared/package.json` to `/var/lib/conduit/app/` on the Droplet.
3. `rsync` `services/web/dist` to `/var/www/conduit/`.
4. `systemctl restart conduit.service` on the Droplet.

The web build needs the API token baked in at build time (see Phase 1's known
limitation -- removed in Phase 2 when we add a real login). The script reads
`VITE_API_TOKEN` from your local env; set it to the same value as `API_TOKEN`
in `/etc/conduit/env` before running.

## Verifying

```bash
# From your laptop:
curl https://conduit.example.com/health
# {"ok":true,"service":"middleman",...,"authRequired":true,...}
```

Then open `https://conduit.example.com/` in a browser, paste the token on the
login screen (Phase 1 work below), and you should see the connections page.

## Logs / ops

```bash
# Middleman logs:
journalctl -u conduit.service -f

# Caddy logs (includes TLS issuance + access):
journalctl -u caddy -f
```

## Backup

The only persistent state is `/var/lib/conduit/data/` (Yjs snapshots) and
later the `/var/lib/conduit/data/conduit.db` (Phase 2). Enable DO Volume
snapshots on a daily schedule from the control panel.

## Known limitations of this Phase 1 setup

- **Single shared API token.** Anyone who has it can do anything. Phase 2 adds
  real per-user accounts. Don't share the token outside your own devices yet.
- **Credentials in browser memory.** SSH passwords / keys you paste into the
  connections form live in the middleman process memory only. A reboot loses
  them and forces re-entry. This is intentional for Phase 1.
- **No rate limiting.** It's a single-user box. Don't expose it to bots; pick
  a hostname that won't be scanned, or put a Cloudflare Access policy in
  front if you're paranoid.
