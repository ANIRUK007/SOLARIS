# SOLARIS — the capture server.
#
# No build step and no dependencies: the app is plain Node and static files, so
# the image is the runtime plus this repository. That is deliberate — a field
# deployment should not need a package registry to be reachable.

FROM node:22-alpine

# Run as a non-root user. If the process is ever compromised, it should not
# also own the filesystem it is running on.
RUN addgroup -S solaris && adduser -S solaris -G solaris

WORKDIR /app
COPY --chown=solaris:solaris . .

# Recordings go to Supabase Storage in a hosted deployment. This directory is
# only used when SOLARIS_AUDIO=disk, and on most platforms it is ephemeral.
RUN mkdir -p /app/dataset && chown solaris:solaris /app/dataset

USER solaris

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

# The platform terminates TLS, so the app itself serves plain HTTP here and
# trusts the proxy's forwarded address for rate limiting.
ENV SOLARIS_TRUST_PROXY=true

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:3001/health || exit 1

CMD ["node", "server.js"]
