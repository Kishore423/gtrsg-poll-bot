# Features

A tour of what each part of the website does. For step-by-step recipes, see
[Common workflows](common-workflows.md).

## Home page

### Managed groups

Your managed Telegram groups appear as a list. Groups are **detected
automatically** — when your bot is added to a Telegram group, that group shows up
here. If your bot is removed from a group, the row disappears automatically.

Each group row shows the group's Telegram name and chat ID. Clicking a group row
opens a popup with three actions:

- **Weekly default template** — set the recurring poll for that group.
- **Skip days** — exclude specific event dates.
- **Custom poll** — create a one-off poll.

### Verify bot

Each group row has a **Verify bot** button. It checks that your bot can actually
post to that specific group by sending a test message. It reports success only
after Telegram accepts that message. Use it if you're unsure a group is wired up.

### Weekly default template

The weekly template is the recurring poll for a group. You choose the release day
and time and the shift options (each shift has a start and end time chosen with a
scroll-wheel time picker). A live **Telegram poll preview** shows the question and
options as they will appear. Click **Save default** to store the template. While
the save is running, the button stays unavailable so one action produces one
completion message.

Once saved, the system automatically generates and sends the poll batch on the
configured release day — you do not create each week's batch by hand.

### Skip event dates

Use **Skip days** to tell the system not to send a poll for specific event dates
(for example a public holiday). Adding a skip date before release removes any
not-yet-sent poll for that date. You cannot "unsend" a poll that has already gone
out to Telegram.

### Custom (one-off) poll

Use **Custom poll** to create a poll for a special date that isn't part of the
weekly template. It starts from your saved template's shifts so you only edit the
exceptions.

### Testing mode

Testing mode is a one-shot check of the complete weekly template:

- A production template must be saved first.
- Temporary release, confirmation, gap-week, shift, and capacity values do not
  overwrite the production template.
- Cron sends the temporary Monday-Sunday batch at the configured release time;
  Telegram poll and confirmation text has no testing label.
- Wheelchair's first confirmation follows the configured time and later event
  confirmations send five minutes apart. PSA's weekly summary remains one
  message at its configured weekday and time.
- After the final confirmation, testing records and votes are removed and the
  complete production template is restored. Telegram messages are deleted
  manually.

## Polls page

The Polls page is a **read-only monitoring view** of scheduled polls. Use
**Date order** to show event dates in ascending (earliest first) or descending
(latest first) order. The control is available to both users and admins.

- **Filters:** filter by event date, Telegram group, and poll type (custom or
  batch default). Admins also get a bot filter. A Telegram group appears only
  once in the group menu even when more than one managed bot is registered in
  that same group.
- **Details:** each poll has a **Details** button that opens an in-page view of
  that poll.
The Polls list refreshes automatically every 15 seconds, so completed Testing
mode cleanup appears without a page reload.
The Polls page has no permanent delete control. To stop a default poll from
being sent, use **Skip days** on the Home page instead.

## Deployment sheets page

For normal users, the account-level **Deployment sheets** switch is off by
default. When enabled, the page appears in the navigation bar. Admins always see
the page and can access deployment sheets across all users' Telegram groups.
The page lists the latest four fully confirmed event weeks, with one Excel
download per Telegram group and week. Deployment downloads do not appear in the
Home group menu. See [Common workflows](common-workflows.md#download-the-deployment-sheet).

## Admin page (admins only)

Admins manage the people who can use the website and the bots assigned to them:

- Add a user by Telegram handle, with or without a bot.
- Edit a user: display name, role (admin/user), enabled/disabled, and the
  assigned bot.
- Assign a bot by pasting its BotFather token, or **Remove bot** to unassign it.
- Enable, disable, or delete a user.
- Refresh a bot's Telegram name and handle (these are read-only, owned by
  Telegram).

Bot tokens and internal bot IDs are never displayed back to you.

## How polls and confirmations work (overview)

- A poll lists shift options; people vote for the shifts they want.
- Slots fill **first-come, first-served** by vote time, up to each shift's
  capacity.
- Before the event, the system posts a **confirmation** message listing who is
  confirmed for each shift. Only confirmed people are listed (waiting-list and
  unfilled slots are not).
- Confirmed people are tagged with their Telegram handle when one is available.
  Accounts without a handle fall back to an immutable Telegram account link.
- Confirmation messages end with the saved note (for example `take note pls`),
  followed by `@CD_gtrsg @CD2_gtrsg` on the final line.

> TODO: confirm the exact wording and format of the confirmation message with a
> supervisor before treating this description as authoritative.
