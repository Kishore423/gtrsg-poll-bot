# Account and access

How accounts work, how to sign in and out, and what your role can do.

## How accounts are created

You cannot self-register. An administrator adds your Telegram handle to the
website's approved list first. Until that happens, requesting a code will not sign
you in.

If you try to sign in and nothing happens, the most likely reason is that your
handle has not been added yet, or the handle you typed does not exactly match the
one your admin entered. Ask your administrator to check.

## Roles

There are two roles:

- **User** — sees and manages only the Telegram groups that **their own bot** is
  in. Users do not see the Admin page.
- **Admin** — sees all groups and bots, and can manage the list of users and
  their bots from the Admin page. An admin can also open a verified user's
  account in a separate test tab from the user roster.

## Admin user testing

On the **Admin** page, click **View as user** beside an enabled, Login_bot-verified
account. The account opens in a separate tab with the same group, poll, and
deployment access that the selected user has. The Admin roster remains open in
the original tab, so different users can be tested in separate tabs.

An amber **Testing as** banner remains visible while the test view is active.
Click **Exit user view** to return that tab to the administrator account. Closing
the tab also ends that tab's test view. Test views do not replace the admin's
normal sign-in and do not impose a separate short timeout; they cannot outlive
the underlying admin session.

## Signing in

Sign-in uses a one-time six-digit code delivered in Telegram. See
[Getting started](getting-started.md) for the full walkthrough. In short:

1. Press **Start** once in the Telegram login bot (scan the QR code or use the
   link).
2. Enter your Telegram handle and click **Send code**.
3. Enter the six-digit code to finish.

Notes:

- A code is valid for only a few minutes and for a limited number of attempts.
- There is a short cooldown between code requests. If you request too many in a
  short time you'll be asked to wait before trying again.
- Use **Resend code** if your code expired or didn't arrive.

## Verifying your Telegram handle

The first time you press **Start** in the login bot, the website links your
account to your Telegram identity — but only if the handle Telegram reports
matches the handle your admin entered exactly. If they don't match, your account
stays "Awaiting login-bot verification" and you'll get a short message in
Telegram explaining the mismatch. Ask your admin to confirm the exact handle.

## Your profile

Once signed in, your display name (or handle) appears in the navigation bar.
Click it to open the account menu, where you can:

- **Upload a profile picture.** Pictures are resized in your browser and there is
  a small size limit. Click an existing picture to view it full-screen or delete
  it. You can only change your own picture.
- **Deployment sheets.** This switch is off by default. Turn it on to add
  **Deployment sheets** to your navigation bar. The setting applies only to your
  account and does not change what another user sees.
- **Sign out.**

## Changing your handle or display name

- Your **Telegram handle** is owned by Telegram and is read-only on the website.
  If you change your @handle in Telegram, it refreshes on the website after you
  interact with the login bot again (for example, the next time you sign in).
- Your **display name** is a label an administrator can set for you.

## Signing out

Open the account menu from your name in the navigation bar and choose **Sign
out**. Your session also expires on its own after a period of time, after which
you'll sign in again with a fresh code.
