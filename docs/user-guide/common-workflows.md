# Common workflows

Step-by-step recipes for the things you'll do most often. If a step doesn't
behave as described, see [Troubleshooting](troubleshooting.md).

## Sign in

1. Open the login bot in Telegram and press **Start** (scan the QR code on the
   sign-in panel, or use the link). You only do this once per device.
2. Enter your Telegram handle and click **Send code**.
3. Enter the six-digit code from Telegram.

See [Getting started](getting-started.md) for detail.

## Add your bot to a Telegram group

1. In Telegram, add your bot to the group as you would any member.
2. Return to the website's **Home** page. The group appears automatically in your
   managed groups list (you may need to refresh or refocus the page).
3. Click **Verify bot** on the group row to confirm the bot can post there.

> Note: the bot uses Telegram privacy mode, so it detects the group when it is
> added. If the group doesn't appear, send a message or `/start@yourbot` in the
> group, then refresh the Home page.

## Set up a weekly poll template

1. On **Home**, click the group row, then **Weekly default template**.
2. Choose the **release day** and **release time**.
3. Add shift rows; for each, set the start and end time with the scroll-wheel
   picker. The label fills in automatically from the times.
4. Check the **Telegram poll preview** below the shifts.
5. Click **Save default**.

The system will generate and send the batch automatically on the release day. You
do not create each week's polls by hand.

## Skip an event date

1. On **Home**, open the group and choose **Skip days**.
2. Add the event date to skip.
3. Save.

If the poll for that date hasn't been sent yet, it is removed. If it has already
been sent to Telegram, skipping cannot recall it.

## Create a one-off (custom) poll

1. On **Home**, open the group and choose **Custom poll**.
2. Adjust the shifts (they start from your saved template).
3. Set the date and timing, review the preview, and create the poll.

## Send a test poll

1. On **Home**, in the template section, use **Test template poll**.
2. Optionally set a release date and a short confirmation delay to smoke-test the
   confirmation message.
3. Send. You'll see "poll sent, please check telegram", then check the group in
   Telegram.

Test polls do not affect your real template or scheduled polls.

## Download the deployment sheet

1. Open your account menu from your name in the navigation bar.
2. If you are a normal user, turn on **Deployment sheets**. Admins have it
   enabled automatically.
3. Open **Deployment sheets** from the navigation bar.
4. Find the confirmed week and Telegram group you need.
5. Click **Download Excel**.

The sheet has fixed Telegram handle and name columns, followed by one column per
event date. Each bordered date cell stacks that person's confirmed shifts and is
blank if they are not deployed. The header stays visible while you scroll. Only
confirmed people are included. A sheet appears only after every poll currently
in that group's Monday-Sunday batch has had its confirmation sent. The panel
shows the latest four confirmed event weeks across all groups available to your
account. Admins see groups across all users; normal users see only groups
belonging to their assigned bot.

## View a poll's details

1. On the **Polls** page, find the poll (use the filters if needed).
2. Click **Details** to open the in-page details view.

## (Admin) Add a user and assign a bot

1. Go to **Admin**.
2. Add the user by their exact Telegram handle. You can leave the bot blank and
   assign it later.
3. To assign a bot, edit the user and paste the bot's BotFather token.
4. Ask the user to press **Start** in the login bot so their account verifies.

## (Admin) Move a bot to a different user

1. Edit the user who currently has the bot and click **Remove bot**.
2. Edit the target user and paste the same BotFather token to assign it there.

## (Admin) Test a user's account

1. Go to **Admin** and find an enabled user who is verified by Login_bot.
2. Click **View as user**. Their account opens in a separate tab while the Admin
   roster stays open.
3. Confirm the amber **Testing as** banner names the intended user, then test
   their groups, polls, or deployment access.
4. Click **Exit user view** when finished, or close that test tab.

Each test tab keeps its own selected user. Opening one user's test view does not
change another tab or sign the actual user out.
