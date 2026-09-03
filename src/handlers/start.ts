import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { inlineButton, inlineKeyboard, mainMenuKeyboard } from "../toolkit/index.js";
import { Store } from "../store.js";

// The /start handler renders the bot's MAIN MENU — the primary way users operate
// a button-first bot. A feature adds its own button by calling
// `registerMainMenuItem(...)` in its own `src/handlers/<slug>.ts`; this handler
// renders whatever is registered (plus a Help button), so you do NOT edit this
// file to add a feature. Send ONE message — no placeholder line above the menu.
const composer = new Composer<Ctx>();

const WELCOME = "مرحباً بك في متجر شمس كاش.";

composer.command("start", async (ctx) => {
  const store = new Store(ctx);
  if (!(await store.available())) {
    await ctx.reply(`${WELCOME}\n\nالمتجر غير مُعدّ للحفظ بعد. تواصل مع المالك.`, { reply_markup: mainMenuKeyboard() });
    return;
  }
  const products = await store.products();
  if (!products.length) {
    await ctx.reply(`${WELCOME}\n\nلا توجد منتجات بعد — سيضيف المالك منتجات قريباً.`, { reply_markup: mainMenuKeyboard() });
    return;
  }
  const rows = products.map((product) => [inlineButton(`شراء ${product.title}`, `order:summary:${product.id}`)]);
  rows.push(...(mainMenuKeyboard().inline_keyboard as typeof rows));
  await ctx.reply("اختر منتجاً لعرض تفاصيله وبدء الشراء.", { reply_markup: inlineKeyboard(rows) });
});

// "Back to menu" — re-render the main menu in place from any sub-view.
composer.callbackQuery("menu:main", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(WELCOME, { reply_markup: mainMenuKeyboard() });
});

export default composer;
