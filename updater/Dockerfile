FROM node:22-alpine
RUN apk add --no-cache docker-cli docker-cli-compose git curl postgresql-client
RUN git config --global --add safe.directory /workspace
WORKDIR /opt/updater
COPY updater/server.mjs ./server.mjs
ENV NODE_ENV=production PORT=4010 UPDATE_TOKEN_FILE=/run/fledge-updater/token
EXPOSE 4010
CMD ["node", "server.mjs"]
