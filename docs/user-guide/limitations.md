# Limitations

What the website currently cannot do, so you know what to expect.

## Exact poll timing is not guaranteed on every plan

Automatic poll release and confirmation depend on a scheduler that runs on a
fixed cadence. On some hosting plans that cadence is only once a day, so a poll or
confirmation may not go out at the exact minute you configured. If precise timing
matters, ask your administrator whether a more frequent scheduler is enabled, or
use a manual/test send to verify.

## You must press "Start" in the login bot

The login bot cannot send you a code until you've opened its chat and pressed
**Start**. This is a Telegram restriction, not something the website can work
around.

## The bot must be added to a group before it can manage it

The website can only manage groups your bot has been added to in Telegram. It
cannot join groups for you.

## Skipping a date cannot recall a sent poll

If a poll has already been delivered to Telegram, adding a skip date will not
remove it. Skip dates only prevent polls that haven't been sent yet.

## The deployment sheet shows confirmed people only

Waiting-list entries and unfilled slots are not included, and the sheet reflects
shift times only — it does not include off-days, sub-shift, or location detail
that isn't part of the poll.

## Self-registration is not available

You cannot create your own account. An administrator must add your Telegram
handle first.

## One bot per user

Each regular user has at most one Telegram bot. Administrators can reassign a bot
between users, but a single user manages one bot's groups.

## No public sharing is set up automatically

Sharing of any knowledge hub or notebook is a manual step performed by an
administrator; it is not automated by the website.

> TODO: confirm with a supervisor whether there are additional operational limits
> (for example maximum shifts per poll or capacity rules) that should be listed
> here for end users.
