FROM node:22-bookworm-slim
WORKDIR /app
COPY plugins/host/package.json plugins/host/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY plugins/host/src ./src
COPY plugins/host/tsconfig.json ./tsconfig.json
RUN npm run check
ENV NODE_ENV=production PORT=4020 PLUGIN_TOKEN_FILE=/run/fledge-plugins/token
USER node
EXPOSE 4020
CMD ["node", "--import", "tsx", "src/server.ts"]
