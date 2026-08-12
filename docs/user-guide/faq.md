# Frequently asked questions

## Do I need a password?

No. You sign in with a one-time six-digit code sent to you in Telegram. There is
no password to remember.

## Why do I have to press "Start" in the login bot?

Telegram only allows a bot to message you after you've opened the chat and pressed
**Start**. That's how the login bot is able to send you your code.

## How long is my sign-in valid?

Your session lasts for a while and then expires, after which you sign in again
with a fresh code. You can also **Sign out** at any time from the account menu.

## Why don't I see the Admin page?

It's only shown to administrators. Regular users manage just their own groups.

## Why can I only see some groups?

Regular users see only the groups their own bot is in. Administrators see all
groups.

## Can I edit my Telegram handle on the website?

No. Your handle is owned by Telegram and is read-only here. Change it in Telegram
and it refreshes on the website the next time you interact with the login bot.

## How are shift slots allocated?

First-come, first-served by the time each person votes, up to each shift's
capacity. Voting earlier improves your chances for a limited shift.

## Does rehearsing a batch create duplicate test polls?

No. A weekly batch rehearsal temporarily sends the actual upcoming batch. After
its confirmation is sent, rehearsal votes are cleared and the same records are
kept for their real release, cutoff, and confirmation times. Rehearsal timing is
stored separately and never overwrites those production timestamps. The rows
remain **Batch default** on the Polls page.

## What is the deployment sheet?

A formatted Excel workbook with one row per person and one column per event
date, showing each person's confirmed shifts for one Telegram group and event
week. Only confirmed people are listed. Turn on **Deployment sheets** from your
account menu to add the latest four confirmed weeks to your navigation bar.

## Why did a poll arrive later than the exact time I set?

The production scheduler checks for due polls every minute. A poll set for 13:30
should normally be sent at 13:30 or shortly after the next minute check. Telegram
and network processing can add a small delay, so the setting is minute-accurate,
not second-accurate.

## How are people tagged in confirmation messages?

The confirmation uses each person's Telegram handle when available. If the
person has no handle, the application uses a Telegram account link instead.

## Why does deleting a poll in Telegram not remove it from Polls?

Telegram does not notify normal bots when an ordinary group poll or message is
manually deleted. For test polls, use **Reset test batch** on the Polls page. It
deletes the known test messages, hides the saved records, and keeps them ready
for their original production release.

## Who do I contact for access or problems?

Your administrator manages the user list and bots. For sign-in problems, start
with [Troubleshooting](troubleshooting.md).
