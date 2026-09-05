# Node 24 = Active LTS (Stand 2026-09); ab 2026-10-28 auf node:26-alpine wechseln (Plan 09)
FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .
USER node
EXPOSE 8080
CMD ["node", "server.js"]
