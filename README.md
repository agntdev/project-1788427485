# متجر شمس

بوت تيليجرام لبيع منتجات رقمية مع تكامل محفظة Shams Cash للدفع داخل الدردشة وتسليم يدوي للمالك.

Spec: [`docs/blueprint.md`](docs/blueprint.md).

Built on [agnt-gm.ai](https://agnt-gm.ai). The whole bot is built and refined here as pull requests across successive build passes.

## API

The Worker also exposes `/api/v1`. Send `Authorization: Bearer <token>` on every request. Tokens are stored only as SHA-256 hashes in D1; create a scoped token once with an existing admin token: `POST /api/v1/tokens` with `{"scope":"write","rate_limit":60}`. The returned token is shown once. Revoke it with `DELETE /api/v1/tokens/{id}`.

`GET /products`, `POST /products`, `GET|PUT|DELETE /products/{id}`, `POST /orders`, `GET|PATCH /orders/{id}`, and `POST /orders/{id}/mark_delivered` use JSON. A product create body contains `title`, `price`, `currency`, `description`, and `delivery_method`; an order contains `product_id`, `quantity`, and optional buyer details/metadata. For example:

```sh
curl -H 'Authorization: Bearer TOKEN' -H 'content-type: application/json' \
  -d '{"product_id":"prd_…","quantity":1}' https://BOT.example/api/v1/orders
```

Orders share the Telegram order store and trigger the same owner delivery action. API-created orders without a Telegram chat can still be marked delivered and retain their delivery details in the API.
