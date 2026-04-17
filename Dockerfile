# Use Playwright's official image - has Chromium, Node, all OS deps preinstalled.
# IMPORTANT: The image tag MUST match the playwright npm version in package.json,
# otherwise the installed browser binary won't match the version the JS library
# looks for. If you bump `playwright` in package.json, bump this tag too.
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

# Install only production deps. Playwright is in dependencies (not dev) so it
# installs fine here; the browser binary is already in the base image.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy app source (.dockerignore excludes node_modules, .git, etc.)
COPY . .

# Railway sets PORT at runtime; expose for documentation.
EXPOSE 3000

# Run as non-root for security (the base image creates 'pwuser')
USER pwuser

CMD ["node", "server/index.js"]
