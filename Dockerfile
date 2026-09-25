# Chatbot server image (Q&A debate over the same multi-agent core used by
# the VS Code extension). This does NOT run the VS Code extension itself —
# only the standalone src/server/** entry point, which never imports
# `vscode` (compiling the whole src/ tree is harmless: @types/vscode is a
# dev-only, erased-at-compile-time dependency).

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run compile

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/out ./out
COPY public ./public

ENV PORT=8787
ENV CHAT_DATA_DIR=/data
EXPOSE 8787
VOLUME ["/data"]

CMD ["node", "out/server/index.js"]
