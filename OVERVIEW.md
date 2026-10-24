# Telegram

Connect Telegram direct messages, groups and forum topics to ordinary Paseo
chats. Link an existing agent, or create a separate chat per conversation in a
workspace. Optionally use a profile from the Bots plugin.

## Set up your bot

A new, empty bot from [@BotFather](https://t.me/BotFather) is enough. No bot code
or separate hosting is required.

1. Open Telegram in Paseo's sidebar and connect the bot's token.
2. Create the private setup link, open it with your Telegram account and press
   **Start** to confirm the owner.
3. Choose an existing Paseo chat, or a workspace with a provider/model or optional
   Bots profile. Set who can use it and select **Save settings**.
4. Message the bot privately, or select **Add to group**, choose a group and
   confirm administrator access in Telegram. No moderation rights are requested.

A token alone does not enable replies. The screen shows the remaining setup
step until an owner and destination are saved. The selected model provider or
subscription must already work in Paseo. Group setup checks message access
automatically and offers **Fix group access** if ordinary mentions are hidden.
BotFather changes and Inline Mode are not required with administrator access.

## How replies work

The daemon receives messages with polling, so no public webhook endpoint or
open app is required. Requests reach the chosen Paseo agent's provider; its
public progress and final answer return to the original Telegram conversation.
Private reasoning and raw tool output are not forwarded.

Final answers arrive as new replies at the bottom. Once all parts are delivered,
the task's working status, permission card and service confirmations disappear.
Questions and people's replies stay in the conversation. Cleanup and confirmed
delivery boundaries survive plugin reloads; uncertain sends are never repeated.

Telegram requests use the chosen Paseo agent's tools and permissions. This
connector does not supply a model subscription or grant additional tools.

## Approvals in Telegram

Pending agent permissions appear in one updating English card. The owner and
separately designated approvers can allow once, remember the provider's exact
tool grants, deny, or **Grant full access** to that chat while preserving its
history. Reply commands provide the same controls. The original task keeps
waiting and returns its final answer after approval in Telegram or Paseo.

Workspace profiles can select **Full access** for newly created agents.
Permission to ask the bot questions does not grant authority to approve actions.

## Group access

Choose who can connect groups: the owner, the owner and allowed users, anyone,
or approval in Paseo for each new group. Separately choose who can request work
inside admitted groups: the owner and allowed users, Telegram group
administrators, or all members. The paired owner can always request work.

Pending groups cannot run work. Approve or reject them in the sidebar; rejection
makes the bot leave. Existing installations keep their access settings on update.
Connector service messages are English; agent answers keep their own language.
