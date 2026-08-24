# Deploying SOLARIS

The host is not decided yet, so this is written the other way round: what any
platform has to give the app, and then the shortest path on each of the usual
ones. The app is plain Node with no dependencies and no build step, so there is
very little to get wrong.

## What the app needs from a host

Four things, and only four.

| | Why |
| --- | --- |
| **HTTPS, terminated for you** | Browsers refuse microphone access on an insecure origin. Without it the app loads and then cannot record — the worst failure, because it looks like it works. A self-signed certificate is not enough: every contributor taps through a warning, which teaches exactly the wrong instinct. |
| **A tier that does not sleep** | An idling instance drops the request that wakes it, and that request is somebody's recording. |
| **Two environment variables** | `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`. |
| **A port and a health check** | It listens on `PORT` (default 3001) and answers `GET /health`. |

Set `SOLARIS_TRUST_PROXY=true` **only** when something really is in front of the
app — which is true on every managed platform below, and false on a plain
`docker run`. The rate limiter counts per address; behind a load balancer every
request otherwise looks like it came from the balancer. Set it where it is not
true and anyone can spoof a header for a fresh quota, which is worse than no
rate limiting because it looks like protection.

## Where credentials go

**This repository is public. Nothing secret is committed to it, and nothing
should be.** A `service_role` key here would be scraped by bots within minutes,
and it bypasses row-level security on every table in the project — full read and
write on the recordings and the account store. Deleting it later does not help;
it stays in the history.

Every platform below has a place to put environment variables. That is where
they go, and they are injected at run time.

The two GitHub repository secrets already set (`SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`) are there for CI to use if a deploy workflow ever needs
them. They are not what the running app reads — the app reads whatever the host
gives it.

## Render

`render.yaml` is already in the repository and is read on its own.

1. New → Web Service → connect `ANIRUK007/SOLARIS`.
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in the dashboard. Both are
   marked `sync: false` in the file precisely so they cannot be committed.
3. Pick a paid instance type. The free one sleeps.

Deploys on every push once connected. TLS is automatic.

## Railway, Koyeb, or anything Heroku-shaped

Same shape: connect the repository, let it build the `Dockerfile`, set the two
variables plus `SOLARIS_TRUST_PROXY=true`, point the health check at `/health`.
Nothing in the app is specific to a platform.

## Fly.io

`fly.toml` is in the repository — Mumbai region, HTTPS forced, one machine kept
running. Not currently in use, kept because it costs nothing to leave.

```sh
fly launch --no-deploy
fly secrets set SUPABASE_URL=... SUPABASE_SERVICE_KEY=...
fly deploy
```

## Your own server

```sh
docker build -t solaris .
docker run -d -p 3001:3001 \
  -e SUPABASE_URL=https://yourproject.supabase.co \
  -e SUPABASE_SERVICE_KEY=sb_secret_... \
  solaris
```

This serves plain HTTP, so put a reverse proxy in front of it for the
certificate. Caddy is the least work — two lines, and it gets and renews the
certificate itself:

```
solaris.example.com {
    reverse_proxy 127.0.0.1:3001
}
```

Then add `-e SOLARIS_TRUST_PROXY=true`, because now there really is a proxy.

## First run against a new Supabase project

```sh
npm run migrate:sql     # applies db/schema.sql and db/002_security_and_streaks.sql
npm run migrate         # loads the 1,482 words and any local accounts
npm run test:db         # verifies the schema against the real database
```

Storage creates its own private `recordings` bucket on first write. Private
always — consent to contribute to a language archive is not consent to be
published.

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

Rotate at the provider, then update the variable on the host and restart. Any
key that has ever been committed, pasted into a chat, or shown in a screen share
must be treated as compromised — including the Sarvam and Groq keys that are
still in this repository's history from when they were in `index.html`.
