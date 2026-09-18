# ZeroTodo online — tiny, dependency-free image.
FROM node:20-alpine

WORKDIR /app

# Only these are needed: server + static frontend. No npm install (zero deps).
COPY server ./server
COPY public ./public

# Persisted data lives here — mount a volume at /data (or ZT_DATA_DIR).
ENV PORT=8080 ZT_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080

# Run as an unprivileged user.
USER node

CMD ["node", "server/server.js"]
