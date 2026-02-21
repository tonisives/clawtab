# Build stage
FROM node:24-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.28.2 --activate

WORKDIR /app

COPY website/package.json website/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY website/ ./

RUN pnpm build

# Runtime stage - nginx to serve static files
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY website/nginx.conf /etc/nginx/conf.d/default.conf
COPY docs/ /usr/share/nginx/html/docs/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
