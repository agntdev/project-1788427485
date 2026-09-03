import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard } from "../toolkit/index.js";
import { Store } from "../store.js";

const composer = new Composer<Ctx>();
async function showOrders(ctx: Ctx, edit: boolean): Promise<void> {
  const store = new Store(ctx);
  if (!(await store.available())) { const t="المتجر غير مُعدّ للحفظ بعد. تواصل مع المالك."; if(edit) await ctx.editMessageText(t); else await ctx.reply(t); return; }
  const buyer = ctx.from?.id;
  if (!buyer) { await ctx.reply("تعذر معرفة حسابك. افتح المحادثة الخاصة بالبوت ثم حاول مرة أخرى."); return; }
  const orders = await store.buyerOrders(buyer);
  const text = orders.length ? orders.map((o) => `طلب ${o.id.slice(-6)}: ${o.delivery_status === "delivered" ? "تم التسليم" : "بانتظار التسليم"}`).join("\n") : "لا توجد طلبات بعد — اختر منتجاً لبدء الشراء.";
  const markup = inlineKeyboard([[inlineButton("العودة للقائمة", "menu:main")]]);
  if(edit) await ctx.editMessageText(text,{reply_markup:markup}); else await ctx.reply(text,{reply_markup:markup});
}
composer.command("orders", async (ctx) => showOrders(ctx, false));
composer.callbackQuery("orders:show", async (ctx) => { await ctx.answerCallbackQuery(); await showOrders(ctx, true); });
export default composer;
