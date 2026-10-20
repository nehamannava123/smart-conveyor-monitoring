FROM node:22-alpine

# Install ffmpeg for local computer vision video inspection
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Ensure data directory has proper permissions for node user
RUN mkdir -p /app/data /app/data/models && chown -R node:node /app

USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:4000/api/health || exit 1

CMD ["node", "server/index.js"]
