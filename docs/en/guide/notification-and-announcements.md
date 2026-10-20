# Notifications & Announcements

There are two kinds of messaging: **notifications** for individuals (in-app messages and email,
delivered per event) and **announcements** for everyone (a banner in the top bar). Both are
configured under “System Settings → **Notifications**”.

## In-app messages

In-app messages live behind the **bell** in the top bar; there is no separate notification page:

- The unread count is polled every 60 seconds; the list is fetched only when the popover opens and
  shows the 20 most recent items.
- Clicking an item marks it read; you can also “Mark all as read”, or “Clear all” (with a
  confirmation).
- More than 99 unread items are shown as `99+`.
- In-app messages are **never cleaned up automatically** and stay until the user clears them; they
  cannot be filtered by event type or read state.

## Events and mandatory delivery

There are 14 event types (plus a “test” event for configuration checks):

| Event | Trigger |
| --- | --- |
| Remote login | The login IP is not among the usual login cities (controlled by “Security → Authentication → Remote login notifications”) |
| Password expiring / Password expired | Daily check: reminders every day during the last two days before expiry |
| Account expiring / Account disabled / Account enabled | Daily check and administrator actions |
| Disabled for inactivity | Daily check (threshold in “Security”, inactive user handling) |
| Session taken over | Another login replaced the current session |
| Password reset by admin / One-time code reset by admin | Administrator actions on the user detail page |
| Role assigned / Role removed | Permission changes |
| Scheduled task failed | A scheduled task failed |
| Email delivery failed | Sending an email failed (in-app only) |

**Mandatory** events ignore subscription switches and are only delivered in-app (email still depends
on subscriptions and SMTP configuration):

- **Mandatory for administrators**: password reset, one-time code reset, role assigned, role removed,
  email delivery failed. These unconditionally go to all administrators.
- **Mandatory for the account holder**: remote login, password expiring/expired, account expiring,
  account disabled/enabled, disabled for inactivity, session taken over, scheduled task failed. These
  unconditionally go to the person concerned — **even while the account is disabled**, so a
  disablement notice still reaches them.

Every other event follows the subscription rules below.

## Email

SMTP is configured under “System Settings → Notifications → Email settings”:

| Field | Notes |
| --- | --- |
| SMTP host / port | Port defaults to 465 |
| Username / password | The password is encrypted separately; leave it empty to keep the stored one |
| From address / sender name | What recipients see |
| Encryption | `none` / `starttls` / `ssl` (default `ssl`); self-signed certificates can skip server verification |
| Days before password expiry | 7 by default |
| In-app / email switches | One switch per channel; **turning both off stops notifications entirely** |

The same page has two buttons: **Send test** (sends a message to a given address using the saved
configuration, to verify SMTP) and **Run daily check now** (triggers the password/account expiry
checks immediately instead of waiting for the background job).

### Email templates

Each event has a template (subject + body + enabled flag) and can be customised with `{{variable}}`
placeholders. Unknown placeholders are **kept verbatim** in the output, which makes typos visible.
Emails are **plain text**; HTML and attachments are not supported.

Available placeholders per event:

| Event | Placeholders |
| --- | --- |
| Remote login | `username`, `ip`, `time`, `provider`, `userAgent` |
| Password expiring | `username`, `days`, `expireDate` |
| Password expired | `username`, `expireDate` |
| Disabled for inactivity | `username`, `days` |
| Account expiring | `username`, `days`, `expireDate` |
| Account disabled / enabled | `username`, `operator`, `time` |
| Password reset | `username`, `operator`, `time` |
| Role assigned / removed | `username`, `role`, `time` |
| Email delivery failed | `time`, `address`, `event`, `reason` |
| Scheduled task failed | `taskName`, `taskType`, `cluster`, `key`, `reason`, `time` |
| Test | `time` |

When an email fails, administrators get an in-app message; the same failure reason is reported at most
once per hour to avoid flooding.

## Subscriptions

“System Settings → Notifications → Subscriptions” is configured per “event × channel × recipient”:

| Field | Values |
| --- | --- |
| Event | The list above, with select-all |
| Channel | In-app / email |
| Recipient type | Specific users, specific email addresses, all enabled users |
| Recipient | Depends on the recipient type |

Two constraints: a specific user must have an email address configured; and the “specific email
addresses” type only works with the email channel. The list shows existing subscriptions, each of
which can be toggled or deleted.

**Granularity limit**: subscriptions only have the three dimensions event × channel × recipient —
there is **no cluster, namespace or resource-type dimension**, so “only scheduled task failures on
the prod cluster” cannot be expressed.

## Announcements

“System Settings → Notifications → Announcements” creates a banner for every signed-in user.

| Field | Notes |
| --- | --- |
| Title | Up to 255 characters |
| Body | Up to 8192 characters, supports a Markdown subset and named colour spans (e.g. `{warning}Maintenance tonight{/warning}`); raw HTML is **not** accepted |
| Level | Info / warning / danger |
| Priority | Ordering when several announcements are active |
| Start / end time | Empty means immediate / never expires; the end time must be after the start time |
| Scrolling | None / continuous / fixed-speed |
| Enabled | Disabling removes it from the banner immediately |

Display rules:

- Only announcements that are **enabled, started and not expired** are shown; several active ones are
  merged into a single track, keeping the highest level.
- The banner can be paused on hover, dragged, and expanded to read the full text.
- At most **20** announcements can be active at once.
- Announcements are **global**: there is no audience or target-user field and no read state, and users
  cannot dismiss or silence them — only the end time or an administrator can.

## Permissions

Everything under the “Notifications” section — email settings, templates, subscriptions and
announcements — is covered by the single **`settings.notification`** section permission
(announcements have no dedicated permission), and all of it sits in the admin API group, so an
administrator identity is required. Section grants are described in
[RBAC Configuration](../config/rbac-config).

There is no user-side notification preferences page: regular users can only receive notifications and
do “Mark all as read” or “Clear all”.