# Cluster Management

Cluster management APIs are under `/api/v1/admin/clusters/`.

These endpoints require an authenticated admin user, or an API key with the `admin` role.

## List clusters

```http
GET /api/v1/admin/clusters/
```

Example:

```bash
curl \
  -H "Authorization: kite1-adminsecret" \
  https://kite.example.com/api/v1/admin/clusters/
```

Response example:

```json
[
  {
    "id": 1,
    "name": "demo-cluster",
    "description": "staging cluster",
    "enabled": true,
    "inCluster": false,
    "isDefault": true,
    "prometheusURL": "http://prometheus.monitoring.svc:9090",
    "config": "",
    "version": "v1.31.0",
    "badgeEnabled": true,
    "badgeText": "Staging",
    "badgeColor": "#0011ff",
    "badgeIconEnabled": true,
    "badgeIconText": "Staging",
    "badgeIconUrl": "/api/v1/clusters/1/badge-icon?v=8f14e45fceea167a"
  }
]
```

Note: the badge fields (`badgeEnabled`, `badgeText`, `badgeColor`, `badgeIconEnabled`,
`badgeIconText`, `badgeIconUrl`) are always returned verbatim by this endpoint so the
admin UI can edit them. `GET /api/v1/clusters`, which feeds the cluster switcher and the
header, only includes `badgeEnabled` / `badgeText` / `badgeColor` when `badgeEnabled` is
true; the icon fields (`badgeIconEnabled` / `badgeIconText` / `badgeIconUrl`) follow
`badgeIconEnabled` instead and are independent of the badge switch.

## Create a cluster

```http
POST /api/v1/admin/clusters/
Content-Type: application/json
```

Request body:

```json
{
  "name": "demo-cluster",
  "description": "staging cluster",
  "config": "<kubeconfig-yaml>",
  "prometheusURL": "http://prometheus.monitoring.svc:9090",
  "inCluster": false,
  "isDefault": true
}
```

Example:

```bash
curl \
  -X POST \
  -H "Authorization: kite1-adminsecret" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"demo-cluster",
    "description":"staging cluster",
    "config":"apiVersion: v1\nkind: Config\n...",
    "prometheusURL":"http://prometheus.monitoring.svc:9090",
    "inCluster":false,
    "isDefault":true
  }' \
  https://kite.example.com/api/v1/admin/clusters/
```

Response example:

```json
{
  "id": 1,
  "message": "cluster created successfully"
}
```

## Update a cluster

```http
PUT /api/v1/admin/clusters/:id
Content-Type: application/json
```

Request body:

```json
{
  "description": "production cluster",
  "prometheusURL": "http://prometheus.monitoring.svc:9090",
  "isDefault": false,
  "enabled": true,
  "badgeEnabled": true,
  "badgeText": "Staging",
  "badgeColor": "#0011ff",
  "badgeIconEnabled": true,
  "badgeIconText": "Staging"
}
```

Example:

```bash
curl \
  -X PUT \
  -H "Authorization: kite1-adminsecret" \
  -H "Content-Type: application/json" \
  -d '{
    "description":"production cluster",
    "enabled":true
  }' \
  https://kite.example.com/api/v1/admin/clusters/1
```

Response example:

```json
{
  "message": "cluster updated successfully"
}
```

Notes:

- `config` is optional on update. If omitted, the existing kubeconfig is kept.
- `name` can be changed by passing a new non-empty value.
- Badge fields are optional too: sending a subset leaves the rest untouched. When
  `badgeEnabled` is true, `badgeText` must not be empty; `badgeColor` only accepts
  `#RRGGBB`; `badgeText` is capped at 16 characters (the UI shows it in full, never
  truncated) and `badgeIconText` at 6, and
  anything longer returns 400 (never silently truncated).
- Icon images do not go through this endpoint: `badgeIconUrl` is maintained only by the
  upload/delete endpoints below, and passing it here has no effect. That keeps the
  "icon bytes exist ⇔ the URL points at them" invariant intact.

## Upload / replace the cluster icon

```http
POST /api/v1/admin/clusters/:id/badge-icon
Content-Type: multipart/form-data
```

Form field:

| Field | Type | Description |
| --- | --- | --- |
| `file` | file | Icon image, required |

Example:

```bash
curl \
  -X POST \
  -H "Authorization: kite1-adminsecret" \
  -F "file=@./icon.png" \
  https://kite.example.com/api/v1/admin/clusters/1/badge-icon
```

Response example:

```json
{
  "message": "badge icon updated successfully",
  "badgeIconUrl": "/api/v1/clusters/1/badge-icon?v=8f14e45fceea167a"
}
```

Notes:

- Only **PNG / JPEG** are accepted, detected from the **file content** (not the file name
  or `Content-Type`); SVG and GIF are rejected — SVG can carry inline scripts, which would
  be stored XSS when served inline.
- At most 1 MiB and at most 1024 pixels per side.
- The image is stored in the instance database (table `cluster_badge_icons`) and
  `badgeIconEnabled` is switched on as a side effect.
- A successful upload returns a new `badgeIconUrl` (`?v=` is the content hash), so a
  changed image gets a new URL, invalidating client caches and allowing a long cache on
  the fetch endpoint.
- Failures return 400 (bad type / content / dimensions) or 413 (too large) with a body
  such as `{"code":"cluster_icon_invalid_type","error":"...","params":{...}}`. A failed
  upload never writes to the database and never disturbs the icon in use.

## Remove the cluster icon

```http
DELETE /api/v1/admin/clusters/:id/badge-icon
```

Example:

```bash
curl \
  -X DELETE \
  -H "Authorization: kite1-adminsecret" \
  https://kite.example.com/api/v1/admin/clusters/1/badge-icon
```

Response example:

```json
{
  "message": "badge icon deleted successfully"
}
```

Notes: the bytes and `badgeIconUrl` are cleared together so no dangling URL is left
behind; the icon falls back to the icon text or the default icon. `badgeIconText` and
`badgeIconEnabled` are untouched. Deleting again is a no-op and still returns 200.

## Get the cluster icon

```http
GET /api/v1/clusters/:id/badge-icon
```

Example:

```bash
curl \
  -H "Authorization: kite1-adminsecret" \
  https://kite.example.com/api/v1/clusters/1/badge-icon -o icon.png
```

- Returns the image bytes with `Content-Type: image/png` or `image/jpeg`, plus an `ETag`
  (the content hash) and `Cache-Control: private, max-age=31536000, immutable`; honours
  `If-None-Match` with a 304.
- Returns 404 when nothing was uploaded, the id is invalid, or the cluster does not exist
  — the frontend then falls back to the icon text or the default icon.
- Requires a login but not admin rights (the icon is shown in the cluster switcher, which
  every account that can switch clusters already sees).

## Delete a cluster

```http
DELETE /api/v1/admin/clusters/:id
```

Example:

```bash
curl \
  -X DELETE \
  -H "Authorization: kite1-adminsecret" \
  https://kite.example.com/api/v1/admin/clusters/1
```

Response example:

```json
{
  "message": "cluster deleted successfully"
}
```

Note: the default cluster cannot be deleted.

## Import clusters from kubeconfig

This bootstrap endpoint is available at:

```http
POST /api/v1/admin/clusters/import
Content-Type: application/json
```

It is intended for the initial setup flow and only works when no clusters exist yet.

Request body:

```json
{
  "config": "<kubeconfig-yaml>",
  "inCluster": false
}
```

In-cluster import example:

```json
{
  "inCluster": true
}
```
