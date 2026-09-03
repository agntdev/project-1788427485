import { describe, expect, it } from "vitest";
import { handleApi } from "../src/api.js";

describe("REST API authentication", () => {
  it("rejects a request without a bearer token", async () => {
    const response = await handleApi(new Request("https://bot.example/api/v1/products"), {});
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "A valid bearer token is required." });
  });

  it("does not notify Telegram when authentication fails", async () => {
    const response = await handleApi(new Request("https://bot.example/api/v1/orders", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ product_id: "x", quantity: 1 }),
    }), { BOT_TOKEN: "not-used", ADMIN_CHAT_ID: "1" });
    expect(response.status).toBe(401);
  });
});
