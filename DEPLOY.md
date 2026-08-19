# Deploying SOLARIS

The server is plain Node with no dependencies, so deployment is mostly a
question of where the credentials live and who terminates TLS.

Two things are non-negotiable:

- **HTTPS.** Browsers refuse microphone access on an insecure origin. Without
  it the app loads and then cannot record, which is the worst possible failure
  because it looks like it works.
- **A tier that does not sleep.** A sleeping instance drops the request that
  wakes it, and that request is somebody's recording.

## Where the secrets go

This repository is public. Nothing secret is committed to it, and nothing
secret should be — a `service_role` key in a public repo is scraped by bots
within minutes, and it bypasses row-level security on every table in the
project. Credentials are set on the platform instead, where they are injected
at run time.

| Secret | Where it is set | What it is |
| --- | --- | --- |
| `SUPABASE_URL` | Fly secrets / Render dashboard | The project URL |
| `SUPABASE_SERVICE_KEY` | Fly secrets / Render dashboard | `service_role` key — full read/write, never send to a browser |
| `FLY_API_TOKEN` | GitHub → Settings → Secrets → Actions | Ships code. Cannot read the archive. |

The GitHub repository secrets are only what CI needs to *deploy*. The app's own
credentials are never handed to GitHub at all.

## Fly.io

```sh
fly launch --no-deploy            # reads fly.toml; keep the app name "solaris"
fly secrets set \
  SUPABASE_URL=https://yourproject.supabase.co \
  SUPABASE_SERVICE_KEY=sb_secret_...
fly deploy
```

`fly.toml` already pins the region to Mumbai, forces HTTPS, keeps one machine
running, and health-checks `/health`.

After the first deploy, pushes to `main` deploy themselves — see
`.github/workflows/deploy.yml`. Create the deploy token with
`fly tokens create deploy -x 8760h` and paste it into the repository secret
`FLY_API_TOKEN`.

## Render

Connect the repository; `render.yaml` is read on its own. Set `SUPABASE_URL`
and `SUPABASE_SERVICE_KEY` in the dashboard — both are marked `sync: false`
precisely so they cannot be committed. Use a paid instance type; the free one
sleeps.

## Anything else that runs a container

```sh
docker build -t solaris .
docker run -p 3001:3001 \
  -e SUPABASE_URL=... \
  -e SUPABASE_SERVICE_KEY=... \
  -e SOLARIS_TRUST_PROXY=true \
  solaris
```

Set `SOLARIS_TRUST_PROXY=true` **only** when something really is in front of
the app. Trusting `X-Forwarded-For` on a directly exposed server lets anyone
set the header and collect a fresh rate-limit quota per request, which is worse
than no rate limiting because it looks like protection.

## First run against a new Supabase project

```sh
npm run migrate:sql     # applies db/schema.sql and db/002_security_and_streaks.sql
npm run migrate         # loads the 1,482 words and any local accounts
npm run test:db         # verifies the schema against the real database
```

Storage creates its own private `recordings` bucket on first write.

## Access

Open sign-up is the default. For a closed study:

```
SOLARIS_OPEN_REGISTRATION=false     # a lead creates every account
SOLARIS_INVITE_CODE=...             # or: open, but only to people with the code
```

## Getting the archive back out

```sh
npm run export
```

Writes every recording, its raw take, and the session metadata to a folder,
reading from whichever backend is configured. The recordings are the archive —
the word list, the accounts and the coverage counts can all be rebuilt from
them, and nothing can rebuild them.

## Rotating a credential

Rotate at the provider, then `fly secrets set` the new value; the app restarts
on its own. Any key that has ever been committed, pasted into a chat, or shown
in a screen share must be treated as compromised — including the keys that were
in `index.html` in this repository's history.
