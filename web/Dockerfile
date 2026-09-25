FROM node:22-bookworm-slim
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
ARG NEXT_PUBLIC_API_URL=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_GITHUB_REPOSITORY=
ENV NEXT_PUBLIC_GITHUB_REPOSITORY=$NEXT_PUBLIC_GITHUB_REPOSITORY
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run check && npm run build
ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
