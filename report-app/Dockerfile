FROM node:22-alpine

WORKDIR /app

# No npm dependencies — the server uses only Node built-ins
COPY server.cjs mailer.cjs scheduler.cjs index.cjs index.html charts.html advisor.html raw.html ./

ENV PORT=3000
EXPOSE 3000

# Run as non-root
USER node

CMD ["node", "index.cjs"]
