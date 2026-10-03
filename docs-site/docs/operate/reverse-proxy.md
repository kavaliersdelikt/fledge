---
title: Reverse proxy and TLS
---

# Reverse proxy and TLS

Run the panel and API on **one site** so the session cookie (`HttpOnly`, `SameSite=Strict`) works. Send `/api/*` to
the API (port 4000) and everything else to the panel (port 3000). Both must allow **WebSocket upgrades**: the
browser live console uses `/api/servers/:id/live` and agents use their own sockets.

Settings to apply with any proxy:

```ini
WEB_ORIGIN=https://panel.example.com
NEXT_PUBLIC_API_URL=https://panel.example.com
TRUST_PROXY=1
NODE_ENV=production   # already set for the API container; makes cookies Secure
```

After changing `NEXT_PUBLIC_API_URL`, rebuild: `docker compose up --build -d`.

Keep `API_BIND` and `WEB_BIND` on `127.0.0.1` when the proxy runs on the same host. If the proxy is on another host,
bind to a private interface and firewall the ports.

::: code-group

```text [Caddy]
panel.example.com {
	handle /api/* {
		reverse_proxy 127.0.0.1:4000
	}
	handle {
		reverse_proxy 127.0.0.1:3000
	}
}
```

```nginx [nginx]
server {
    listen 443 ssl http2;
    server_name panel.example.com;
    # ssl_certificate / ssl_certificate_key ...

    client_max_body_size 1100m;          # file uploads go through the API (limit is 1 GiB)

    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_request_buffering off;
    }
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```yaml [Traefik (labels)]
# On the api service
- "traefik.http.routers.fledge-api.rule=Host(`panel.example.com`) && PathPrefix(`/api`)"
- "traefik.http.routers.fledge-api.tls.certresolver=letsencrypt"
- "traefik.http.services.fledge-api.loadbalancer.server.port=4000"
# On the web service
- "traefik.http.routers.fledge-web.rule=Host(`panel.example.com`)"
- "traefik.http.routers.fledge-web.tls.certresolver=letsencrypt"
- "traefik.http.services.fledge-web.loadbalancer.server.port=3000"
```

:::

## Checklist

- `curl -I https://panel.example.com` shows the panel's `Content-Security-Policy` and `X-Frame-Options` headers.
- The console shows live output (WebSockets work) and file uploads of a few hundred MB succeed.
- Type a range into **Settings → Panel → Security → Administrator IP allow-list**: the editor tells you which address the API sees for you. It must be your real address, not the proxy's (otherwise `TRUST_PROXY` is wrong).
- Node agents use the same HTTPS URL as the panel; see [Connect a node](/agent/connect).
- If you use object storage, its endpoint is reachable from nodes and browsers, with TLS outside private networks.
