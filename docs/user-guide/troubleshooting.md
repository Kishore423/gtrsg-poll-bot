# Troubleshooting

Common problems and how to resolve them. If your issue isn't here, check the
[FAQ](faq.md) or contact your administrator.

## I click "Send code" but no code arrives

- **Press Start in the login bot first.** Telegram only lets the bot message you
  after you've opened the chat and pressed **Start**. Scan the QR code on the
  sign-in panel or use the link, press Start, then request the code again.
- **Check your handle.** It must match exactly the handle your admin approved.
- **Wait out the cooldown.** There's a short delay between code requests and a
  limit per hour. If you've requested several codes quickly, wait and try again.
- Use **Resend code** rather than reloading the page.

## The code says it's invalid or expired

- Codes expire after a few minutes and allow only a few attempts. Request a fresh
  one with **Resend code** and enter it promptly.
- Make sure you're entering the most recent code, not an older one.

## Signing in does nothing / I'm not recognised

Your Telegram handle probably hasn't been added to the approved list yet, or it
doesn't match what your admin entered. Ask your administrator to add or correct
your handle. Self-registration is not possible.

## My account shows "Awaiting login-bot verification"

Your handle in Telegram must match the handle your admin entered exactly before
your account links. Press **Start** in the login bot; if it still doesn't verify,
ask your admin to confirm the exact spelling and capitalisation of your handle.

## My Telegram group doesn't appear on Home

- Confirm your bot was actually added to the group in Telegram.
- Refresh the Home page or click away and back (groups reload on focus).
- If it still doesn't appear, send a message or `/start@yourbot` in the group,
  then refresh.
- Use **Verify bot** once the group appears to confirm the bot can post.

## Verify bot fails

- The bot may not be in the group, or may have been removed. Re-add it in
  Telegram.
- Make sure you're verifying the correct group.

## A poll didn't go out when I expected

- Automatic sending depends on the scheduler running. Depending on the hosting
  plan, exact release times may not be minute-accurate — see
  [Limitations](limitations.md).
- Check the **Polls** page to see whether the poll was scheduled.
- If you skipped that date, that's why. Check **Skip days** for the group.

## I skipped a date but the poll still went out

Skipping only prevents polls that haven't been sent yet. A poll already delivered
to Telegram cannot be recalled by skipping.

## The deployment sheet is empty or missing people

- Only **confirmed** people appear. Waiting-list and unfilled slots are omitted.
- If confirmations haven't run yet for a date, that date's column will be blank.

## I can't see the Admin page

The Admin page is only visible to administrators. If you need admin access, ask
an existing administrator to change your role.

## A profile picture won't upload

Pictures are resized in your browser and there's a small size limit. Try a
smaller image. You can only change your own picture.
