# Environment Variables

Kite supports several environment variables by default to change the default values of some configuration items.

- **KITE_CONFIG_FILE**: Path to the configuration file. Available in Kite `v0.10.0` and later. When set, Kite loads cluster, OAuth, LDAP, RBAC, and super user settings from this file. See [Configuration File](/config/config-file) for details.
- **KITE_USERNAME**: Legacy environment variable for the initial administrator username. It is only used for env-to-DB migration when `KITE_CONFIG_FILE` is not set.
- **KITE_PASSWORD**: Legacy environment variable for the initial administrator password. It is only used for env-to-DB migration when `KITE_CONFIG_FILE` is not set.
- **KUBECONFIG**: Legacy kubeconfig environment variable used to import clusters when `KITE_CONFIG_FILE` is not set.
- **ANONYMOUS_USER_ENABLED**: Enable anonymous user access, default value is `false`. When enabled, all access will no longer require authentication and will have the highest permissions by default.

- **JWT_SECRET**: Secret key used for signing and verifying JWT. If unset, a random secret is generated on first boot and stored in the database. Must be at least 32 bytes when set.
- **KITE_ENCRYPT_KEY**: Secret key used for encrypting sensitive data, such as user passwords, OAuth clientSecret, kubeconfig, etc. **Required**: the server refuses to start without it unless `KITE_ALLOW_INSECURE_SECRETS=true`. Rotating it makes existing stored credentials unreadable — re-save every credential after rotation.
- **KITE_REQUIRE_ENCRYPT_KEY**: When `true`, `KITE_ENCRYPT_KEY` must be set even if `KITE_ALLOW_INSECURE_SECRETS=true`.
- **KITE_ALLOW_INSECURE_SECRETS**: Development-only escape hatch (`true`/`false`). Allows the built-in keys and short JWT secrets. Never enable in production.

- **HOST**: Used for generating OAuth 2.0 authorization callback addresses, default will be obtained from request headers. If you find the result not as expected, you can manually configure this environment variable.

- **TRUSTED_PROXIES**: Comma-separated list of reverse proxy, ingress, or load balancer IPs/CIDRs that Kite should trust when reading `X-Forwarded-For` / `X-Real-IP` to determine the client IP. By default, Kite trusts local/private network ranges (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `::1`, `fc00::/7`) so common ingress deployments can report real client IPs. Set a narrower value such as `TRUSTED_PROXIES=10.42.0.0/16,192.168.1.10` for production, or `TRUSTED_PROXIES=none` to ignore all client-supplied forwarding headers.

- **KUBECTL_TERMINAL_IMAGE**: Docker image used for the kubectl terminal.

- **NODE_TERMINAL_IMAGE**: Docker image used for generating Node Terminal Agent.

- **CLUSTER_AGENT_IMAGE**: Docker image used when generating the Cluster Agent manifest for Cluster Agent clusters.

- **ENABLE_ANALYTICS**: Enable data analytics functionality, default value is `false`. When enabled, Kite will collect limited data to help improve the product.

- **PORT**: Port on which Kite runs, default value is `8080`.

## Database

- **DB_TYPE**: Database type: `sqlite` (default), `mysql` or `postgres`.
- **DB_DSN**: Database DSN. Defaults to `dev.db` for SQLite.
- **KITE_DB_MAX_OPEN_CONNS**: Maximum open database connections (default `100`).
- **KITE_DB_MAX_IDLE_CONNS**: Maximum idle database connections (default `10`).
- **KITE_DB_CONN_MAX_LIFETIME_MINUTES**: Maximum connection lifetime in minutes (default `10`).

## Runtime & Operations

- **KITE_BASE**: Base path when Kite is served behind a sub-path (e.g. `/kite`).
- **CORS_ALLOWED_ORIGINS**: Comma-separated list of origins allowed for CORS. Development only.
- **DISABLE_GZIP**: Set to `true` to disable gzip response compression (default: disabled).
- **DISABLE_VERSION_CHECK**: Set to `true` to disable the version update check.
- **NAMESPACE**: Kubernetes namespace where terminal/kubectl agent pods are created (default `kube-system`).
- **KITE_METRICS_TOKEN**: Bearer token required to access `/metrics`. Unset leaves the endpoint unauthenticated.
- **KITE_ENABLE_PPROF**: Set to `true` to expose pprof on `localhost:6060` (may leak secrets via heap dumps; opt-in only).
- **KITE_DISABLE_CSP**: Set to `true` to disable the Content-Security-Policy header (development only).
- **KITE_ALLOW_PRIVATE_REGISTRIES**: Set to `true` to allow the image tag lookup to reach private/loopback registry addresses.
