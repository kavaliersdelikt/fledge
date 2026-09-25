FROM node:22-bookworm-slim
WORKDIR /app
COPY api/package.json api/package-lock.json ./api/
WORKDIR /app/api
RUN npm ci --no-audit --no-fund
COPY api/src ./src
COPY api/tsconfig.json ./tsconfig.json
COPY db /app/db
RUN npm run check
ENV NODE_ENV=production
EXPOSE 4000
CMD ["npm", "start"]
