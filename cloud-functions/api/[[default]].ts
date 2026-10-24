/* 餐饮日报 · EdgeOne 云函数入口
   ---------------------------------------------------------------------------
   [[default]] 是 EdgeOne 的 catch-all 路由：/api/ 下所有没被静态资源命中的
   路径都进这里，再由 _core.ts 的 handle() 按 path 分发（与 Deno 版同一套路由）。
   真正的逻辑都在 _core.ts（不导出 handler，所以不会被注册成独立路由）。

   这里再包一层 try/catch：KV 抖动/超时时（kvGuard 抛错）直接回一个**快速的
   JSON 503**，而不是让请求挂到网关超时（表现为 504、访客要等 30 秒）。
*/

import { handle } from "./_core";

export const onRequest = async (context: any) => {
  try {
    return await handle(context);
  } catch (e) {
    const msg = String((e && (e as any).message) || e).slice(0, 200);
    return new Response(
      JSON.stringify({ ok: false, error: "服务暂时不可用：" + msg, code: "handler_error" }),
      {
        status: 503,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  }
};
