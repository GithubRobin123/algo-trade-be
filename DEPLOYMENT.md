# Deployment

The backend runs on an EC2 server under pm2 (app `algo-backend`). The frontend is on Vercel.

## Deploy the backend (GitHub Actions)

**GitHub → Actions → "Deploy backend (EC2)" → Run workflow → branch `main`.**

The workflow ([.github/workflows/deploy-backend.yml](.github/workflows/deploy-backend.yml)):

1. **Verify:** `npm ci`, typecheck and build on GitHub. A broken commit never reaches the server.
2. **Pre-flight on the server:** `scripts/deploy.sh main --check` (changes nothing).
3. **Deploy on the server:** [scripts/deploy.sh](scripts/deploy.sh)
   - refuses if files were edited directly on the server
   - fast-forwards to `origin/main`
   - runs `npm ci` only when dependencies changed
   - builds into `dist-next/` and swaps it in only after a successful build
   - restarts **only** `algo-backend`. `cf-tunnel` and anything else on the server are never touched, so the public tunnel URL does not change
   - checks `http://127.0.0.1:4000/api/health`; if the new version is not healthy it **rolls back automatically**

Check what is running: `GET /api/health` returns `build.commit` and `build.deployedAt`.

Manual rollback on the server, if ever needed:

```bash
cd ~/algo-trade-be && git log --oneline -5            # pick the commit to go back to
git reset --hard <commit> && npm ci --include=dev && npm run build && pm2 restart algo-backend
```

Never run `pm2 restart all` or restart `cf-tunnel`: a restarted quick tunnel gets a new random URL.

### One-time setup: repository secrets

Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `EC2_HOST` | server public DNS name |
| `EC2_USER` | `ec2-user` |
| `EC2_SSH_KEY` | private key of the deploy key (its public key is in `~/.ssh/authorized_keys` on the server) |
| `EC2_KNOWN_HOSTS` | the server host key line (`ssh-keyscan -t ed25519 <host>`) |

If the server's public address changes (for example after a stop/start without an Elastic IP), update `EC2_HOST` and `EC2_KNOWN_HOSTS`.

To deploy automatically on every push to `main`, add `push: { branches: [main] }` under `on:` in the workflow.

## Frontend

Vercel builds and deploys on every push to `main` of the frontend repo. The backend URL comes from the Vercel environment variables `VITE_API_BASE_URL` and `VITE_WS_URL`.

## Moving from the Cloudflare quick tunnel to your own domain

The pipeline does not use the public URL (it deploys over SSH and checks health on the server), so it needs **no change**. Only these settings point at the public URL:

1. **Route the domain to the backend**, e.g. `api.yourdomain.com`, with either:
   - a **named** Cloudflare tunnel (`cloudflared tunnel create`, `cloudflared tunnel route dns`), which has a fixed hostname and needs no open ports, or
   - an Elastic IP + DNS A record + an HTTPS reverse proxy to `localhost:4000`. nginx on the server also serves other apps, so add a **separate** `server_name` block and don't change the existing ones.
2. **Backend `.env` on the server:** `UPSTOX_REDIRECT_URI=https://api.yourdomain.com/api/auth/upstox/callback`
3. **Upstox developer console → your app:** set the Redirect URL and the **Notifier Webhook URL** to the new domain (`/api/auth/upstox/callback`).
4. **Vercel environment:** `VITE_API_BASE_URL=https://api.yourdomain.com` and `VITE_WS_URL=wss://api.yourdomain.com/ws`, then redeploy the frontend.
5. **Restart the backend** (run the workflow, or `pm2 restart algo-backend`) and test the login and the dashboard.
6. Only after everything works on the domain: `pm2 delete cf-tunnel && pm2 save`.
