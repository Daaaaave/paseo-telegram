# Telegram

Connect Telegram direct messages, groups and forum topics to ordinary Paseo
chats. Link an existing agent, or create a separate chat per conversation in a
workspace. Optionally use a profile from the Bots plugin.

The sidebar screen connects a BotFather token, pairs its owner, configures
routing and access, and opens linked chats in Paseo. The daemon receives messages
with polling, so no public webhook endpoint or open app is required.

Telegram requests use the chosen Paseo agent's tools and permissions. This
connector does not supply a model subscription or grant additional tools.
