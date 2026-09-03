import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import { adminChatId, inlineButton, inlineKeyboard, registerMainMenuItem, requireOwner } from "../toolkit/index.js";
import { Store, type Product } from "../store.js";

registerMainMenuItem({ label: "المنتجات", data: "catalog:show", order: 10 });
registerMainMenuItem({ label: "طلباتي", data: "orders:show", order: 20 });
registerMainMenuItem({ label: "إدارة المتجر", data: "owner:panel", order: 30 });

const composer = new Composer<Ctx>();
const back = inlineKeyboard([[inlineButton("العودة للقائمة", "menu:main")]]);
const storageProblem = "المتجر غير مُعدّ للحفظ بعد. تواصل مع المالك.";
function catalogText(products: Product[]): string { return products.length ? "اختر منتجاً للاطلاع على تفاصيله وشرائه." : "لا توجد منتجات بعد — سيضيف المالك منتجات قريباً."; }
async function showCatalog(ctx: Ctx, edit: boolean): Promise<void> {
  const store = new Store(ctx);
  if (!(await store.available())) { if (edit) await ctx.editMessageText(storageProblem, { reply_markup: back }); else await ctx.reply(storageProblem, { reply_markup: back }); return; }
  const products = await store.products();
  const keys = products.map((p) => [inlineButton(`${p.title} — ${p.price_shams_cash}`, `order:summary:${p.id}`)]);
  keys.push([inlineButton("العودة للقائمة", "menu:main")]);
  if (edit) await ctx.editMessageText(catalogText(products), { reply_markup: inlineKeyboard(keys) }); else await ctx.reply(catalogText(products), { reply_markup: inlineKeyboard(keys) });
}
composer.callbackQuery("catalog:show", async (ctx) => { await ctx.answerCallbackQuery(); await showCatalog(ctx, true); });
composer.callbackQuery("owner:panel", async (ctx) => { await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx))) return; const store=new Store(ctx); if(!(await store.available())) { await ctx.reply(storageProblem); return; } await ctx.editMessageText("أدِر منتجاتك وطلباتك من هنا.", { reply_markup: inlineKeyboard([[inlineButton("إضافة منتج", "product:add")],[inlineButton("تعديل منتج", "product:edit")],[inlineButton("حذف منتج", "product:delete")],[inlineButton("الطلبات الجديدة", "owner:orders")],[inlineButton("العودة للقائمة", "menu:main")]]) }); });
composer.callbackQuery("product:add", async (ctx) => { await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx))) return; ctx.session = { step: "add_product" }; await ctx.reply("أرسل المنتج بهذا الشكل: الاسم | الوصف القصير | السعر"); });
// Owner shortcuts are retained for owners who already know the store commands.
composer.command("add_product", async (ctx) => { if (!(await requireOwner(ctx))) return; ctx.session = { step: "add_product" }; await ctx.reply("أرسل المنتج بهذا الشكل: الاسم | الوصف القصير | السعر"); });
composer.on("message:text", async (ctx, next) => { if (ctx.session.step !== "add_product") return next(); if (!(await requireOwner(ctx))) return; const parts=ctx.message.text.split("|").map((x)=>x.trim()); if(parts.length!==3 || parts.some((x)=>!x)){ await ctx.reply("اكتب الاسم والوصف والسعر، وبين كل جزء علامة |."); return; } const store=new Store(ctx); if(!(await store.available())){await ctx.reply(storageProblem);return;} const product:Product={id:crypto.randomUUID().slice(0,12),title:parts[0],short_description:parts[1],price_shams_cash:parts[2],stock_status:"in_stock"}; await store.saveProduct(product); ctx.session={}; await ctx.reply("تمت إضافة المنتج. يمكنك عرضه من قائمة المنتجات."); });
composer.callbackQuery("product:edit", async (ctx) => { await ctx.answerCallbackQuery(); if (!(await requireOwner(ctx))) return; const products=await new Store(ctx).products(); if(!products.length){await ctx.reply("لا توجد منتجات لتعديلها بعد.");return;} await ctx.reply("اختر المنتج الذي تريد تعديله.", {reply_markup:inlineKeyboard(products.map((p)=>[inlineButton(p.title,`product:edit:${p.id}`)]))}); });
composer.command("edit_product", async (ctx) => { if (!(await requireOwner(ctx))) return; const products=await new Store(ctx).products(); if(!products.length){await ctx.reply("لا توجد منتجات لتعديلها بعد.");return;} await ctx.reply("اختر المنتج الذي تريد تعديله.", {reply_markup:inlineKeyboard(products.map((p)=>[inlineButton(p.title,`product:edit:${p.id}`)]))}); });
composer.on("callback_query:data", async (ctx,next)=>{ const data=ctx.callbackQuery.data; if(!data.startsWith("product:edit:")) return next(); await ctx.answerCallbackQuery(); if(!(await requireOwner(ctx)))return; const id=data.slice(13); const product=await new Store(ctx).product(id); if(!product){await ctx.reply("لم يعد هذا المنتج متاحاً.");return;} ctx.session={step:"edit_product",productId:id}; await ctx.reply("أرسل: الاسم | الوصف القصير | السعر | متوفر أو نفد"); });
composer.on("message:text", async (ctx,next)=>{if(ctx.session.step!=="edit_product")return next();if(!(await requireOwner(ctx)))return;const p=ctx.message.text.split("|").map(x=>x.trim());if(p.length!==4||p.some(x=>!x)||!(["متوفر","نفد"].includes(p[3]))){await ctx.reply("اكتب: الاسم | الوصف القصير | السعر | متوفر أو نفد");return;}const store=new Store(ctx);const old=await store.product(ctx.session.productId!);if(!old){ctx.session={};await ctx.reply("لم يعد هذا المنتج متاحاً.");return;}await store.saveProduct({...old,title:p[0],short_description:p[1],price_shams_cash:p[2],stock_status:p[3]==="متوفر"?"in_stock":"out_of_stock"});ctx.session={};await ctx.reply("تم تحديث المنتج.");});
composer.callbackQuery("product:delete", async(ctx)=>{await ctx.answerCallbackQuery();if(!(await requireOwner(ctx)))return;const products=await new Store(ctx).products();if(!products.length){await ctx.reply("لا توجد منتجات لحذفها بعد.");return;}await ctx.reply("اختر المنتج الذي تريد حذفه.",{reply_markup:inlineKeyboard(products.map(p=>[inlineButton(p.title,`product:delete:${p.id}`)]))});});
composer.command("delete_product", async (ctx) => { if (!(await requireOwner(ctx))) return; const products=await new Store(ctx).products(); if(!products.length){await ctx.reply("لا توجد منتجات لحذفها بعد.");return;} await ctx.reply("اختر المنتج الذي تريد حذفه.",{reply_markup:inlineKeyboard(products.map(p=>[inlineButton(p.title,`product:delete:${p.id}`)]))}); });
composer.on("callback_query:data",async(ctx,next)=>{const data=ctx.callbackQuery.data;if(!data.startsWith("product:delete:"))return next();await ctx.answerCallbackQuery();if(!(await requireOwner(ctx)))return;await new Store(ctx).deleteProduct(data.slice(15));await ctx.reply("تم حذف المنتج.");});
export async function notifyOwner(ctx: Ctx, text: string, orderId: string): Promise<boolean> { const admin=adminChatId(ctx as any); if(!admin)return false; try {await ctx.api.sendMessage(admin,text,{reply_markup:inlineKeyboard([[inlineButton("تسليم الطلب",`deliver:${orderId}`)]] )});return true;}catch{return false;} }
export default composer;
