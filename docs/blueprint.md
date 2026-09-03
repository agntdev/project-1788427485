# Shams Cash Digital Store — Bot specification

**Archetype:** commerce

**Voice:** professional and concise — write every user-facing message, button label, error, and empty state in this voice.

Telegram bot for small digital sellers to showcase products, accept Shams Cash payments in chat, and manually deliver digital goods. Orders trigger notifications to the owner's Telegram account, who then marks them as delivered with attached files/text.

> This is the complete contract for the bot. Implement EVERY entry point, flow, feature, integration, and edge case below. The completeness review checks the bot against this document after each build pass.

## Primary audience

- small digital product sellers

## Success criteria

- User can browse products and complete purchases via Shams Cash
- Owner receives instant order notifications and can manually deliver goods
- Buyer gets delivery confirmation with attached product

## Entry points

Every feature must be reachable from the bot's command/button surface (button-first; only /start and /help are slash commands).

- **/start** (command, actor: user, command: /start) — Show product catalog with buy buttons
- **/orders** (command, actor: user, command: /orders) — View order history and delivery status
- **Buy** (button, actor: user, callback: order:summary) — Initiate purchase flow for selected product

## Flows

### product_catalog
_Trigger:_ /start

1. Show product list with title, description, price, and Buy button
2. On Buy click: show order summary with Pay button
3. On Pay: initiate Shams Cash payment flow
4. On payment confirmation: create order and notify owner

_Data touched:_ Product, Order

### order_delivery
_Trigger:_ new_order_notification

1. Send order notification to ADMIN_CHAT_ID with product and buyer details
2. Owner clicks 'Mark delivered' button
3. Owner provides delivery message/file
4. Bot records delivery and sends to buyer

_Data touched:_ Order

## Owner-supplied settings

The OWNER provides these; they are collected in chat and injected into the environment at deploy. Read each one from the environment where it is used (`ctx.env.<KEY>` / `env.<KEY>` on Cloudflare Workers; `process.env.<KEY>` only as a Node/harness fallback — never the sole read). Do NOT invent your own way of learning the value, do NOT ask for it in a bot message, and do NOT hardcode a default.

- **ADMIN_CHAT_ID** — Telegram chat ID to receive order notifications
  - this is the OWNER's own chat id; the platform already knows it. Read `ADMIN_CHAT_ID` via `ctx.env` (prefer toolkit `adminChatId` / `requireOwner`) — never ask a user, never treat whoever writes first as the admin, never invent claim-admin or open manage for everyone.
  - may be UNSET at runtime: the bot must still start, and the feature needing ADMIN_CHAT_ID must say so plainly instead of failing.

Your behavioral specs run WITHOUT these values, so no spec may depend on one.

## Data entities

Durable data (must survive a restart) uses the toolkit's persistent store, never in-memory maps.

An entity that merely NAMES an owner-supplied setting above (an admin chat, an API account) is not something to store or discover — read it from the environment.

- **Product** _(retention: persistent)_ — Digital product for sale
  - fields: title, short_description, price_shams_cash, stock_status
- **Order** _(retention: persistent)_ — Completed purchase awaiting delivery
  - fields: buyer_id, product_id, amount, payment_status, payment_reference, timestamp, delivery_status, delivery_note
- **Owner** _(retention: persistent)_ — Administrator who receives and processes orders
  - fields: admin_chat_id

## Integrations

- **Telegram** (required) — Bot API messaging and inline buttons
- **Shams Cash** (required) — In-chat payment processing
Call external APIs against their real contract (correct endpoints, ids, params); credentials from env. Do not fake responses.

## Owner controls

- Add product via /add_product
- Edit product via /edit_product
- Delete product via /delete_product

## Notifications

- Order confirmation to buyer
- Delivery status update to buyer
- New order alert to owner with product details

## Permissions & privacy

- Only owner can manage products and delivery
- Buyer data (Telegram ID) stored securely
- Orders visible only to buyer and owner

## Edge cases

- Product is out of stock when user tries to buy
- Shams Cash payment confirmation fails
- Owner attempts to deliver before payment is confirmed
- Catalog is empty when user first opens bot

## Required tests

- End-to-end purchase flow from catalog to delivery
- Owner notification and delivery workflow
- Empty catalog handling
- Out-of-stock product behavior

## Assumptions

- Shams Cash integration is pre-configured
- Owner will manually add products after setup
- All user interactions are in Arabic
- Delivery requires owner action, not automated fulfillment
