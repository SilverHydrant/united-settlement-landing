# Use Playwright's official image - has Chromium, Node, all OS deps preinstalled.
# IMPORTANT: The image tag MUST match the playwright npm version in package.json,
# otherwise the installed browser binary won't match the version the JS library
# looks for. If you bump `playwright` in package.json, bump this tag too.
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

# gosu lets the entrypoint run as root, fix /data's ownership after Railway
# mounts the volume, then exec the real app as pwuser without a sub-shell.
# Small install (~2MB); rm cleans the apt lists so the image doesn't grow.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

# Install only production deps. Playwright is in dependencies (not dev) so it
# installs fine here; the browser binary is already in the base image.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app source (.dockerignore excludes node_modules, .git, etc.)
COPY . .

# Build-time chown of /data. This is a seed value — Railway's volume mount at
# runtime replaces /data with a root-owned filesystem, so entrypoint.sh is
# what actually makes /data writable for pwuser in production.
RUN mkdir -p /data && chown -R pwuser:pwuser /data /app \
    && chmod +x /app/entrypoint.sh

# Railway sets PORT at runtime; expose for documentation.
EXPOSE 3000

# Don't set `USER pwuser` here — the entrypoint needs root to chown /data
# after the volume mount, then drops to pwuser itself via gosu.
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "server/index.js"]
