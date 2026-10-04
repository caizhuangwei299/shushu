
// functions/_middleware.js
export async function onRequest(context) {
  const url = new URL(context.request.url);
  const path = url.pathname;

  // 放行：根路径、API、带扩展名的静态资源
  if (path === '/' || path.startsWith('/api/') || path.includes('.')) {
    return context.next();
  }

  // 匹配订单号格式：/HZxxxxx
  const oid = path.slice(1);
  if (/^HZ[A-Z0-9]{4,}$/i.test(oid)) {
    // 重写到 index.html，浏览器地址栏不变
    const res = await context.env.ASSETS.fetch(new URL('/index.html', url.origin));
    return new Response(res.body, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=UTF-8' }
    });
  }

  return context.next();
}
