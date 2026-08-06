# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary users are GTRSG airline relationship managers responsible for
planning and managing Telegram shift-slot polls. Administrators additionally
control which people may access the application and which dedicated Telegram
bot is assigned to each person.

## Product Purpose

Telegram Poll Manager helps airline relationship managers plan recurring and
one-off shift polls, release them into the correct Telegram groups, monitor
responses, confirm allocations, and export confirmed deployments. Success means
managers can run the weekly polling workflow accurately without manually
rebuilding polls or mixing up users, bots, groups, and schedules.

## Positioning

Telegram Poll Manager combines poll scheduling with a controlled one-user-to-one-
bot ownership model. Each approved user manages the groups detected for their
assigned Telegram bot, while administrators retain centralized access and bot
assignment control.

## Operating Context

- Managers sign in using a one-time code delivered through the dedicated
  Telegram login bot.
- Telegram groups are detected after a user's assigned bot is added to them.
- Each group can have its own weekly default template, skipped event dates, and
  one-off polls.
- Polls collect shift preferences and confirmations allocate available slots
  first-come, first-served.
- The Polls page is used for monitoring and exporting confirmed deployments.
- Administrators manage the approved-user roster and dedicated bot assignments.

## Capabilities and Constraints

- The product supports wheelchair (`WHCL`) and passenger-service (`PSA`)
  shift-slot poll workflows.
- One user may have only one Telegram bot assigned at a time.
- One Telegram bot may be assigned to only one user at a time.
- User access requires administrator approval; Telegram verification alone does
  not authorize access.
- A single assigned bot may participate in multiple Telegram groups, and each
  group keeps its own poll configuration.
- Telegram-owned user and bot identities are mirrored into the application
  rather than freely edited there.
- The application is a Node.js web service hosted on Vercel with Supabase
  Postgres and Telegram webhooks.
- The expansion of the acronym “GTRSG” is not yet confirmed.

## Brand Commitments

- Product name: **Telegram Poll Manager**.
- Use direct operational language suitable for airline relationship managers.
- Preserve the established Telegram-first workflow and terminology.

## Evidence on Hand

- Working application surfaces: Home, Polls, and Admin under `public/`.
- End-user behavior documentation under `docs/user-guide/`.
- Production scheduling, allocation, tenancy, and authentication behavior is
  covered by the automated tests under `test/`.
- Existing Telegram scheduling artwork:
  `public/assets/poll-operations-header.png`.
- No testimonials, performance claims, customer logos, or public brand
  guidelines are available and must not be fabricated.

## Product Principles

1. Keep every user, bot, Telegram group, and schedule relationship explicit.
2. Make recurring poll planning reusable while keeping group-specific control.
3. Fail closed on identity, approval, and tenant access.
4. Give managers visible confirmation for consequential actions.
5. Keep monitoring and deployment information easy to scan and export.
