# Architecture

## Independent choices

A connection belongs to one Telegram bot. Its default destination and optional
chat/topic overrides choose an existing Paseo agent or a workspace. Workspace
routes choose ordinary agent configuration or a Bots profile. Bots is a
server-side adapter, never a mandatory package dependency. This keeps transport,
routing and agent configuration independent.

Partial connection configuration is valid while setting up a bot: the token,
owner pairing and saved destination are separate steps. Client readiness uses
saved configuration, never unsaved form edits. Overrides without a default
enable only their selected conversations. This is routing readiness, not a
check of the model provider's login or subscription.

Telegram ownership, access, agent providers/models, Bots profiles, workspaces,
projects and Git branches come from runtime configuration and Paseo's own
discovery APIs. The shipped plugin includes no operator identity, customer
credentials or project-specific routing. Publication ownership lives in package
and repository metadata; it does not supply agent settings or access to a host.

Telegram conversation identities contain the chat ID and thread ID. Internal
agent/message IDs also include the bot connection ID. Identical Telegram update
IDs from different bots cannot collide. Group-to-supergroup aliases preserve
the original conversation identity. Explicit destination changes create distinct
routes without deleting earlier agents.

## Runtime owners

- `Manager` loads connection configuration, owns the local Paseo connection,
  manages receivers and serves authenticated plugin RPCs.
- `Registry` validates configuration, serializes writes and checks revisions.
  It stores tokens separately and never returns them through list/settings RPCs.
- Each `Bridge` owns a bot's polling, admission, jobs, progress and deliveries.
- `Approvals` owns permission cards and control responses. It uses a separate
  per-agent control queue, so decisions can unblock the task holding the normal
  agent/conversation queues. Native mode changes use the existing local SDK client.
- `TaskMessages` owns final delivery receipts and task-scoped temporary bot
  message IDs. Finals are new replies to their original Telegram requests.
  Cleanup runs only after every final part is confirmed and the task succeeds.
  Late service confirmations and clarification acknowledgements follow the
  source task's cleanup lifecycle. Questions and user answers are retained.
- `GroupSetup` reads `getMe` and `getChatMember` on startup, about once a minute
  during polling, and on explicit checks or membership changes. Unverified or
  failed checks never claim group readiness. Membership updates take precedence
  over older requests. Health is transient; saved admission and routing are unchanged.
- `Router` selects the agent/workspace and configures new agents. Existing agent
  configuration is never overwritten.
- `AgentQueue` serializes conversation work and shared-agent access across bots.
- `BotsAdapter` uses the installed plugin's settings/prompt/mount RPCs. Only
  profile IDs and names leave the server when populating the selector.
- `sync.ts` serializes Git integration by common repository directory and pins
  the fetched commit before touching a conversation worktree.

The server uses a separately authenticated local SDK session for startup without
an app. Lifecycle callbacks follow ZeroSub continuation labels and mark native
question receipts answered. No model provider is implemented or intercepted.

Admission and request permissions are independent policies. The new admission
field defaults to owner-only for old and new configurations; legacy settings
payloads omit it rather than resetting a newer value. Pending approval is not an
admitted group. Review RPCs require the authenticated Paseo control surface, a
paired owner and a current pending record. Group mutations and review/revoke
operations serialize on the shared store while Telegram membership is checked.

The administrators request policy reads Telegram's `getChatAdministrators`
list instead of accepting a user-provided role or caching positive grants.
The paired owner remains allowed. Other senders must have an administrator or
creator entry; operator IDs do not bypass this requirement. Lookup failures
deny access. Authorization runs before dispatch and again after queuing,
before clarification responses and before final delivery. Admission changes do
not implicitly revoke existing groups or stop native agents already running.

Approval authority is a separate owner/approver allowlist. Older save payloads
omit the new field rather than resetting it. Telegram callbacks and reply
commands must match the saved bot/chat/topic/message/agent and random card
token. Native request fingerprints include identity, input, actions and
suggestions. A fresh pending snapshot is checked before each response, and
authorization is rechecked after receipt persistence. Receipts record the
native agent, request, deciding actor and attempt outcome before the RPC.
Uncertain responses never replay, and a continuation cannot reuse an older
agent's card. Callback acknowledgements precede native operations.

Remembered grants accept only native allow-rule suggestions for the exact tool
and local project/session destination. They cannot implicitly change modes or
grant unrelated tools. Full-access mode is a separate explicit action for the
existing chat; changing a profile still affects only newly created agents.
Question forms keep their own answer protocol and are never answered by a tool
approval. Multiple native action choices remain explicit.

Permission attention is nonterminal when the bridge owns the task. It keeps
the original Telegram message and dispatched native request attached across
receiver reloads. Approvals resolved from either client resume observation;
only a real terminal result is delivered as the final answer. The task's model
prompt is never resent to recover a pending approval. Initial card sends use
at-most-once receipts; an authenticated callback can prove an uncertain send's
message ID. Card edits are idempotent, and closed/stale buttons fail closed.

Connector-owned service strings use English only. User input, public agent
commentary, native question content and final answers are transported without
changing their language. Credential redaction still recognizes sensitive text
in supported non-English input.

Group invitation links request only `manage_chat`; Telegram's own confirmation
grants administrator status. The plugin never promotes itself or changes
BotFather privacy settings. Admin membership bypasses privacy mode; ordinary
membership requires disabled privacy. A regular member with default privacy
gets an actionable warning and can still use addressed commands or replies.
Admission checks run independently of message access: pending or rejected groups
receive no setup invitation or agent access. Setup notices accompany new
admissions and membership changes, never a blanket startup broadcast. Failed
notice delivery does not stop polling; the diagnosis remains in Paseo.

## Persistence and recovery

All state documents are versioned and schema-validated. Corrupt state fails
closed instead of resetting a conversation. Writes use private temporary files
and atomic rename. Configuration revision checks prevent clients overwriting
each other's edits.

The job receipt records its destination, route, agent, pre-send timeline boundary,
dispatch state, pending native question and Telegram message ID. A reload
reattaches to an existing dispatched task. An interrupted dispatch searches for
its exact namespaced message ID back to its saved timeline boundary. Changed,
missing or unprovable history requires operator attention instead of replaying
an operation.

Each final chunk has a persisted send boundary and its confirmed Telegram ID.
A reload resumes only unsent parts after a confirmed chunk boundary. A send
with an unknown outcome is not repeated, and its temporary messages remain.
Older interrupted single-chunk final edits retain their idempotent recovery;
already-delivered in-place answers are never treated as temporary progress.

Temporary message IDs come only from confirmed sends or authenticated card
callbacks. Cleanup uses `deleteMessages` in batches of at most 100 IDs, with
chat-wide pacing and bounded persisted retries. It never derives IDs from chat
ranges. Requests, native questions, final replies and older in-place answers
are protected. Successful cleanup removes only its acknowledged IDs, so a late
confirmation is not lost when it arrives during a sweep. A completed task's
cleanup can resume after reload without sending its final answer again.
Expired messages, revoked deletion rights and exhausted retries are left visible;
cleanup failure does not change a confirmed delivery into an agent failure.

## Authorization boundaries

| Boundary                  | Enforcement                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| Paseo operator → settings | Authenticated Paseo plugin RPC; strict input schemas; server-side target checks.                    |
| Telegram owner claim      | Expiring random nonce, SHA-256 hash, constant-time comparison, one-time consumption.                |
| Group admission           | Configured add-event policy or explicit Paseo approval; pending groups have no agent access.        |
| Request sender            | Owner/operator/everyone policy enforced before agent access and again after queuing.                |
| Conversation history      | Per chat/topic routes; global guard requires explicit shared-history opt-in for existing agents.    |
| Clarification answer      | Original form, agent, question message, chat and topic must match.                                  |
| Permissions               | Explicit owner/approver decisions, native request fingerprints and persisted response receipts.     |
| Credentials               | Server-only token files; sanitized API errors; public progress excludes credential-like strings.    |
| External content          | A Telegram request is user input. Quoted third-party content is explicitly identified as untrusted. |

These are transport boundaries on one trusted host. Agent tool permissions and
host-user credentials remain Paseo's responsibility. Bots profiles can
intentionally share their own memory/tools across their chats. Worktrees separate
edits and do not create OS tenants.

## Release

The public repository contains generic code, tests, fixtures and documentation.
Only runtime entries, shared/client/server code, the lockfile, listing assets and
standard package documentation enter the npm artifact. The package check inspects
that allowlist, local import closure, credential-like strings and dependency
integrities.

Git installations run the manifest's `npm ci --omit=dev --ignore-scripts`
preparation command against the committed shrinkwrap before compilation.
`npm run pack` stages the same published files and omits that Git-only command
from the npm manifest, because npm acquisition already installs production
dependencies. Staging never edits the working checkout. Package checks validate
the Git preparation contract and inspect the staged npm files; the release
workflow publishes that staged artifact.

GitHub checks and stable version tags drive npm publishing through OIDC. npm's
Trusted Publisher is configured for `Daaaaave/paseo-telegram` and `publish.yml`.
The initial publication used interactive npm account authorization. Future
versions use the workflow's short-lived OIDC identity without an npm token.
No workflow connects to an installation or deploys to a daemon. Registry review
and an installation's update action are separate from npm publication.

Submit an immutable npm release (`npm:paseo-telegram@<version>`) to the registry.
The published artifact includes the production shrinkwrap; npm acquisition
installs that dependency tree without a Git-only manifest preparation command.
The registry proposes update PRs for new npm versions. Those updates still need
review, and installed daemons keep their approved pin until explicitly updated.

Official contracts checked during implementation:

- [Paseo plugin reference](https://paseo.sh/docs/plugins/reference)
- [Paseo plugin publishing](https://paseo.sh/docs/plugins/publishing)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Telegram administrator discovery](https://core.telegram.org/bots/api#getchatadministrators)
- [Paseo Bots](https://github.com/oliexe/paseo-bots)
