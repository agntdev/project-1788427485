import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { Store } from "../store.js";

const composer = new Composer<Ctx>();
composer.callbackQuery("order:summary", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("اختر منتجاً من قائمة المنتجات أولاً.", { reply_markup: inlineKeyboard([[inlineButton("عرض المنتجات", "catalog:show")]]) });
});
composer.on("callback_query:data", async (ctx, next) => {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith("order:summary:")) return next();
  await ctx.answerCallbackQuery();
  const product = await new Store(ctx).product(data.slice(14));
  if (!product) { await ctx.reply("لم يعد هذا المنتج متاحاً."); return; }
  if (product.stock_status === "out_of_stock") { await ctx.reply("هذا المنتج نفد حالياً. اختر منتجاً آخر."); return; }
  await ctx.editMessageText(`${product.title}\n${product.short_description}\nالسعر: ${product.price_shams_cash} شمس كاش`, { reply_markup: inlineKeyboard([[inlineButton("الدفع بشمس كاش", `payment:start:${product.id}`)], [inlineButton("العودة للمنتجات", "catalog:show")]]) });
});
composer.on("callback_query:data", async (ctx, next) => {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith("payment:start:")) return next();
  await ctx.answerCallbackQuery();
  const product = await new Store(ctx).product(data.slice(14));
  if (!product || product.stock_status === "out_of_stock") { await ctx.reply("هذا المنتج لم يعد متاحاً للشراء."); return; }
  // Shams Cash has no endpoint, credential, or callback contract in this deployment.
  // Never create an order until a provider confirmation can be verified.
  await ctx.reply("الدفع بشمس كاش غير مُعدّ بعد. تواصل مع المالك لإتمام الشراء.");
});
export default composer;
