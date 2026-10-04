// ============ 全局常量 ============
const PHONE_TTL_MS = 90 * 1000;              // 手机号有效期：90 秒
const ACTIVE_INDEX_KEY = '__active_orders__'; // 活跃订单索引键
const ORDER_INDEX_KEY  = '__order_index__';   // 订单列表索引键
const ORDER_INDEX_VERSION = 2;                // v2：只收录已完成（收到验证码）的订单

// ============ 带超时的 fetch ============
async function fetchWithTimeout(url, options = {}, timeout = 4000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw new Error('接码平台请求超时或被中断');
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      }
    });
  }

  const action = url.searchParams.get('action');
  const oid = url.searchParams.get('oid');

  try {
    const kv = env.ORDERS;
    if (!kv) throw new Error('严重错误：后端 KV 数据库 (ORDERS) 未绑定');

    const POOL_KEY = 'phone_pool';
    const LOG_KEY  = 'phone_logs';
    const CARD_KEY = 'card_keys';

    const apiCfg = await kv.get('__api_config__', { type: 'json' }) || {};
    const apiUser = apiCfg.user || '';
    const apiPass = apiCfg.pass || '';
    const sid = url.searchParams.get('sid') || apiCfg.sid || '24085';

    const poolActions = [
      'addPhone', 'removePhone', 'poolList', 'resetPool', 'releasePoolPhone', 'logList',
      'getBalance', 'lockOrder', 'blockPhone',
      'generateCard', 'activateCard', 'verifyCard', 'cardList', 'deleteCard',
      'createOrder', 'listActiveOrders', 'listAllOrders', 'releaseAllOrders',
      'cancelRecvPhone', 'saveApiConfig', 'rebuildOrderIndex'
    ];
    if (!oid && !poolActions.includes(action)) {
      return jsonResponse({ error: '缺少订单ID' }, 400);
    }

    const HAOZHU = { server: 'api.haozhuma.com', user: apiUser, pass: apiPass, sid };

    async function getPool() { const p = await kv.get(POOL_KEY, { type: 'json' }); return p || []; }
    async function savePool(pool) { await kv.put(POOL_KEY, JSON.stringify(pool)); }

    async function getLogs() { const l = await kv.get(LOG_KEY, { type: 'json' }); return l || []; }
    async function saveLogs(logs) {
      if (logs.length > 100) logs = logs.slice(-100);
      await kv.put(LOG_KEY, JSON.stringify(logs));
    }
    async function addLog(phone, oid, action) {
      if (action !== 'sms_received') return;
      const logs = await getLogs();
      logs.push({ phone, oid, action, time: new Date().toISOString() });
      await saveLogs(logs);
    }

    async function getCards() { const c = await kv.get(CARD_KEY, { type: 'json' }); return c || []; }
    async function saveCards(cards) { await kv.put(CARD_KEY, JSON.stringify(cards)); }

    // ============ 活跃订单索引 ============
    async function updateActiveIndex(oid, phone, expire) {
      let index = await kv.get(ACTIVE_INDEX_KEY, { type: 'json' }) || {};
      index[oid] = { oid, phone, expire };
      await kv.put(ACTIVE_INDEX_KEY, JSON.stringify(index));
    }
    async function removeFromActiveIndex(oid) {
      let index = await kv.get(ACTIVE_INDEX_KEY, { type: 'json' }) || {};
      if (index[oid]) { delete index[oid]; await kv.put(ACTIVE_INDEX_KEY, JSON.stringify(index)); }
    }

    // ============ 【重写】订单索引：只收录已完成订单 ============
    // 只收录 status === 'done' 的订单（即收到过验证码的）
    // 重建时只用 kv.list metadata，不做逐 key get，避免子请求超限
    async function buildOrderIndexFromList() {
      console.log('[order-index] 开始构建索引（仅已完成订单）...');
      const collected = [];
      let listCursor = null;
      let pages = 0;

      do {
        const res = await kv.list({ limit: 1000, cursor: listCursor });
        for (const k of res.keys) {
          if (k.name.startsWith('__')) continue;
          if (k.name === POOL_KEY || k.name === LOG_KEY || k.name === CARD_KEY) continue;

          const md = k.metadata || {};
          const status = md.status;   // 可能 undefined（旧数据）
          const createdAt = typeof md.createdAt === 'number' ? md.createdAt : 0;

          // ★ 只保留已完成订单
          //   - 有明确 status 的：必须 === 'done'，其它一律跳过
          //   - 完全没有 status 的（老版本写入的订单）：保守保留，视为历史完成订单
          if (status !== undefined && status !== null && status !== 'done') continue;

          collected.push({ oid: k.name, createdAt });
        }
        listCursor = res.list_complete ? null : res.cursor;
        pages++;
        if (pages > 100) {           // 安全阀：最多 10 万条
          console.warn('[order-index] 达到 100 页上限，停止扫描');
          break;
        }
      } while (listCursor);

      collected.sort((a, b) => {
        if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
        return String(b.oid).localeCompare(String(a.oid), undefined, { numeric: true });
      });

      await kv.put(ORDER_INDEX_KEY, JSON.stringify({
        version: ORDER_INDEX_VERSION,
        items: collected
      }));
      console.log(`[order-index] 构建完成，共 ${collected.length} 条`);
      return collected;
    }

    async function getOrderIndex() {
      const stored = await kv.get(ORDER_INDEX_KEY, { type: 'json' });
      // 版本不匹配（或不存在）→ 自动重建，触发一次性迁移
      if (stored && stored.version === ORDER_INDEX_VERSION && Array.isArray(stored.items)) {
        return stored.items;
      }
      return await buildOrderIndexFromList();
    }

    // 只有当订单变成 done 时才会调用
    async function pushToOrderIndex(oid, createdAt) {
      const items = await getOrderIndex();
      const filtered = items.filter(it => it.oid !== oid);
      filtered.unshift({ oid, createdAt: createdAt || Date.now() });
      if (filtered.length > 20000) filtered.length = 20000;
      await kv.put(ORDER_INDEX_KEY, JSON.stringify({
        version: ORDER_INDEX_VERSION,
        items: filtered
      }));
    }

    async function removeFromOrderIndex(oid) {
      const stored = await kv.get(ORDER_INDEX_KEY, { type: 'json' });
      if (!stored || !Array.isArray(stored.items)) return;
      const filtered = stored.items.filter(it => it.oid !== oid);
      if (filtered.length !== stored.items.length) {
        await kv.put(ORDER_INDEX_KEY, JSON.stringify({
          version: ORDER_INDEX_VERSION,
          items: filtered
        }));
      }
    }

    function generateCardKey() {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const segment = () => {
        let s = '';
        for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
        return s;
      };
      return `HZ-${segment()}-${segment()}`;
    }

    async function getValidToken() {
      if (!HAOZHU.user || !HAOZHU.pass) throw new Error('未配置接码平台账号密码');

      const tokenData = await kv.get('__token_data__', { type: 'json' });
      let tokenStr = tokenData ? tokenData.token : null;
      let tokenExpiry = tokenData ? tokenData.expire : 0;
      const tokenApiUser = tokenData ? tokenData.apiUser : null;
      const tokenApiPass = tokenData ? tokenData.apiPass : null;

      const needLogin = !tokenStr || Date.now() >= tokenExpiry - 300000
        || tokenApiUser !== HAOZHU.user || tokenApiPass !== HAOZHU.pass;

      if (needLogin) {
        const loginResp = await fetchWithTimeout(
          `https://${HAOZHU.server}/sms/?api=login&user=${HAOZHU.user}&pass=${HAOZHU.pass}`
        );
        const loginData = await loginResp.json();
        if (loginData.code == 0) {
          tokenStr = loginData.token || loginData.Token || loginData.access_token;
          tokenExpiry = Date.now() + 3500000;
          await kv.put('__token_data__', JSON.stringify({
            token: tokenStr, expire: tokenExpiry, apiUser: HAOZHU.user, apiPass: HAOZHU.pass
          }));
        } else {
          throw new Error('接码平台登录失败：' + (loginData.msg || ''));
        }
      }
      return tokenStr;
    }

    async function releaseOrderPhone(order, oid) {
      if (!order || !order.phone) return;
      if (order.fromPool) {
        const pool = await getPool();
        const entry = pool.find(p => p.phone === order.phone);
        if (entry && entry.status === 'in_use') {
          entry.status = 'available'; entry.oid = null; entry.expire = null;
          await savePool(pool);
        }
      } else {
        try {
          const tokenStr = await getValidToken();
          const orderSid = order.sid || HAOZHU.sid;
          await fetchWithTimeout(`https://${HAOZHU.server}/sms/?api=cancelRecv&token=${tokenStr}&sid=${orderSid}&phone=${order.phone}`);
        } catch (e) { console.error('释放号码失败:', e); }
      }
      if (oid) await removeFromActiveIndex(oid);
    }

    async function releaseOrderByOid(oid) {
      const order = await kv.get(oid, { type: 'json' });
      if (!order) return { success: false, error: '订单不存在' };
      if (order.status === 'done') return { success: false, error: '订单已完成，无法释放' };
      if (order.status === 'released') return { success: false, error: '订单已被释放过' };

      await releaseOrderPhone(order, oid);
      order.status = 'released'; order.phone = null; order.expire = null; order.code = null;
      await kv.put(oid, JSON.stringify(order), {
        metadata: { createdAt: order.createdAt || 0, status: 'released' }
      });
      // done 是终态，不会离开索引；其它状态本来就不在索引里，无需处理
      return { success: true };
    }

    // ====== 业务分发 ======
    switch (action) {
      case 'saveApiConfig': {
        const newUser = url.searchParams.get('apiUser');
        const newPass = url.searchParams.get('apiPass');
        const newSid  = url.searchParams.get('sid');
        if (!newUser || !newPass) return jsonResponse({ error: '缺少账号或密码' }, 400);
        await kv.put('__api_config__', JSON.stringify({ user: newUser, pass: newPass, sid: newSid }));
        await kv.delete('__token_data__');
        return jsonResponse({ success: true });
      }

      case 'cancelRecvPhone': {
        const phone = url.searchParams.get('phone');
        if (!phone) return jsonResponse({ error: '缺少 phone 参数' }, 400);
        try {
          const tokenStr = await getValidToken();
          const cancelUrl = `https://${HAOZHU.server}/sms/?api=cancelRecv&token=${tokenStr}&sid=${HAOZHU.sid}&phone=${encodeURIComponent(phone)}`;
          const cancelResp = await fetchWithTimeout(cancelUrl);
          const cancelData = await cancelResp.json();

          if (cancelData.code == 0 || cancelData.msg?.includes('成功')) {
            const pool = await getPool();
            const pEntry = pool.find(p => p.phone === phone);
            if (pEntry && pEntry.status === 'in_use') {
              if (pEntry.oid) {
                const order = await kv.get(pEntry.oid, { type: 'json' });
                if (order && order.status === 'active') {
                  order.status = 'released'; order.phone = null; order.expire = null;
                  await kv.put(pEntry.oid, JSON.stringify(order), {
                    metadata: { createdAt: order.createdAt || 0, status: 'released' }
                  });
                  await removeFromActiveIndex(pEntry.oid);
                }
              }
              pEntry.status = 'available'; pEntry.oid = null; pEntry.expire = null;
              await savePool(pool);
            }
            return jsonResponse({ success: true, msg: cancelData.msg || '释放成功' });
          }
          return jsonResponse({ success: false, error: cancelData.msg || '平台释放失败' }, 400);
        } catch (e) {
          return jsonResponse({ error: '请求接码平台失败: ' + e.message }, 500);
        }
      }

      case 'listActiveOrders': {
        const activeIndex = await kv.get(ACTIVE_INDEX_KEY, { type: 'json' }) || {};
        const now = Date.now();
        let changed = false;
        const orders = [];
        for (const oid in activeIndex) {
          const item = activeIndex[oid];
          if (item.expire && now >= item.expire) { delete activeIndex[oid]; changed = true; }
          else orders.push(item);
        }
        if (changed) await kv.put(ACTIVE_INDEX_KEY, JSON.stringify(activeIndex));
        return jsonResponse({ orders });
      }

      // ============ listAllOrders：只列出已完成订单 ============
      case 'listAllOrders': {
        const cursorStr = url.searchParams.get('cursor') || null;
        const limit = Math.min(parseInt(url.searchParams.get('limit')) || 100, 200);

        const index = await getOrderIndex();   // 已按 createdAt 倒序，且只含 done 订单
        const start = cursorStr ? Math.max(parseInt(cursorStr) || 0, 0) : 0;
        const end = Math.min(start + limit, index.length);
        const pageItems = index.slice(start, end);

        const orders = [];
        const BATCH_SIZE = 20;
        for (let i = 0; i < pageItems.length; i += BATCH_SIZE) {
          const batch = pageItems.slice(i, i + BATCH_SIZE);
          const results = await Promise.all(
            batch.map(item =>
              kv.get(item.oid, { type: 'json' }).catch(e => {
                console.error(`读取订单 ${item.oid} 失败:`, e);
                return null;
              })
            )
          );
          batch.forEach((item, idx) => {
            const order = results[idx];
            if (order && order.status === 'done') {   // ★ 二次兜底：只显示 done
              orders.push({
                oid: item.oid,
                phone: order.phone || '---',
                assignedPhone: order.assignedPhone || '',
                status: order.status,
                code: order.code || '',
                expire: order.expire || null,
                doneTime: order.doneTime || null,
                createdAt: order.createdAt || item.createdAt || null,
                phoneAssignedAt: order.phoneAssignedAt || null
              });
            }
          });
        }

        return jsonResponse({
          orders,
          cursor: end < index.length ? String(end) : null,
          list_complete: end >= index.length,
          total: index.length
        });
      }

      // 手动重建索引
      case 'rebuildOrderIndex': {
        await kv.delete(ORDER_INDEX_KEY);
        const items = await buildOrderIndexFromList();
        return jsonResponse({ success: true, total: items.length });
      }

      case 'releaseAllOrders': {
        const activeIndex = await kv.get(ACTIVE_INDEX_KEY, { type: 'json' }) || {};
        const activeOids = Object.keys(activeIndex);
        const results = [];
        for (const oid of activeOids) {
          const result = await releaseOrderByOid(oid);
          results.push({ oid, success: result.success, error: result.error });
        }
        const successCount = results.filter(r => r.success).length;
        return jsonResponse({ success: true, released: successCount, total: results.length, details: results });
      }

      // ============ createOrder：不再入索引 ============
      case 'createOrder': {
        if (!oid) return jsonResponse({ error: '缺少订单ID' }, 400);
        const existing = await kv.get(oid, { type: 'json' });
        if (existing) return jsonResponse({ error: '订单已存在' }, 400);

        const specifiedPhone = url.searchParams.get('phone') || '';
        const ascription = url.searchParams.get('ascription') || '';
        const paragraph  = url.searchParams.get('paragraph')  || '';
        const exclude    = url.searchParams.get('exclude')    || '';
        const isp        = url.searchParams.get('isp')        || '';
        const province   = url.searchParams.get('Province')   || '';
        const uid        = url.searchParams.get('uid')        || '';

        const createdAt = Date.now();
        const newOrder = {
          status: 'new',
          sid,
          assignedPhone: specifiedPhone,
          phone: null, expire: null, code: null,
          fromPool: false,
          createdAt,
          filters: { ascription, paragraph, exclude, isp, province, uid }
        };

        await kv.put(oid, JSON.stringify(newOrder), {
          metadata: { createdAt, status: 'new' }
        });

        // ★ 不再调用 pushToOrderIndex —— 新订单不是 done 状态，不进列表
        return jsonResponse({ success: true });
      }

      case 'generateCard': {
        const type = url.searchParams.get('type') || 'trial';
        const count = parseInt(url.searchParams.get('count')) || 1;
        if (count < 1 || count > 100) return jsonResponse({ error: '数量需在1-100之间' }, 400);
        const duration = type === 'month' ? 30 : 1;
        const cards = await getCards();
        const generated = [];
        for (let i = 0; i < count; i++) {
          const key = generateCardKey();
          cards.push({ key, type, duration, activated: false, activated_at: null, expire_at: null, created_at: Date.now() });
          generated.push(key);
        }
        await saveCards(cards);
        return jsonResponse({ success: true, keys: generated });
      }

      case 'activateCard': {
        const key = url.searchParams.get('key');
        if (!key) return jsonResponse({ error: '缺少卡密' }, 400);
        const cards = await getCards();
        const card = cards.find(c => c.key === key);
        if (!card) return jsonResponse({ error: '卡密不存在' }, 404);
        if (card.activated) {
          if (Date.now() > card.expire_at) return jsonResponse({ error: '卡密已过期' }, 400);
          return jsonResponse({ success: true, expire_at: card.expire_at });
        }
        const now = Date.now();
        card.activated = true; card.activated_at = now;
        card.expire_at = now + card.duration * 86400 * 1000;
        await saveCards(cards);
        return jsonResponse({ success: true, expire_at: card.expire_at });
      }

      case 'verifyCard': {
        const key = url.searchParams.get('key');
        if (!key) return jsonResponse({ error: '缺少卡密' }, 400);
        const cards = await getCards();
        const card = cards.find(c => c.key === key);
        if (!card) return jsonResponse({ error: '卡密不存在' }, 404);
        if (!card.activated) return jsonResponse({ valid: false, msg: '未激活' });
        if (Date.now() > card.expire_at) return jsonResponse({ valid: false, msg: '已过期' });
        return jsonResponse({ valid: true, expire_at: card.expire_at });
      }

      case 'cardList': {
        const cards = await getCards();
        return jsonResponse({ cards });
      }

      case 'deleteCard': {
        const key = url.searchParams.get('key');
        if (!key) return jsonResponse({ error: '缺少卡密' }, 400);
        let cards = await getCards();
        cards = cards.filter(c => c.key !== key);
        await saveCards(cards);
        return jsonResponse({ success: true });
      }

      case 'getBalance': {
        const tokenStr = await getValidToken();
        const balanceResp = await fetchWithTimeout(`https://${HAOZHU.server}/sms/?api=getSummary&token=${tokenStr}`);
        const balanceData = await balanceResp.json();
        if (balanceData.code == 0) {
          const bal = balanceData.balance || balanceData.summary || balanceData.money ||
                      balanceData.data?.balance || balanceData.data?.money || balanceData.amount;
          if (bal === undefined || bal === null) {
            return jsonResponse({ error: '未找到余额字段，原始响应: ' + JSON.stringify(balanceData) });
          }
          return jsonResponse({ balance: bal });
        }
        return jsonResponse({ error: balanceData.msg || '查询失败' });
      }

      case 'blockPhone': {
        const phone = url.searchParams.get('phone');
        if (!phone) return jsonResponse({ error: '缺少 phone 参数' }, 400);
        const tokenStr = await getValidToken();
        const blockResp = await fetchWithTimeout(`https://${HAOZHU.server}/sms/?api=addBlacklist&token=${tokenStr}&sid=${HAOZHU.sid}&phone=${phone}`);
        const blockData = await blockResp.json();
        if (blockData.code == 0) {
          let pool = await getPool();
          pool = pool.filter(p => p.phone !== phone);
          await savePool(pool);
          return jsonResponse({ success: true });
        }
        return jsonResponse({ error: blockData.msg || '拉黑失败' });
      }

      case 'lockOrder': {
        if (!oid) return jsonResponse({ error: '缺少订单ID' }, 400);
        const result = await releaseOrderByOid(oid);
        return result.success ? jsonResponse({ success: true }) : jsonResponse({ error: result.error }, 400);
      }

      case 'poolList': {
        const pool = await getPool();
        return jsonResponse({ pool });
      }

      case 'addPhone': {
        const phone = url.searchParams.get('phone');
        if (!phone) return jsonResponse({ error: '缺少 phone 参数' }, 400);
        const pool = await getPool();
        if (pool.some(p => p.phone === phone)) return jsonResponse({ error: '号码已存在' }, 400);
        pool.push({ phone, status: 'available', oid: null, expire: null });
        await savePool(pool);
        return jsonResponse({ success: true });
      }

      case 'removePhone': {
        const phone = url.searchParams.get('phone');
        if (!phone) return jsonResponse({ error: '缺少 phone 参数' }, 400);
        let pool = await getPool();
        pool = pool.filter(p => p.phone !== phone);
        await savePool(pool);
        return jsonResponse({ success: true });
      }

      case 'resetPool': {
        const pool = await getPool();
        for (const p of pool) {
          if (p.status === 'in_use' && p.oid) {
            const order = await kv.get(p.oid, { type: 'json' });
            if (order && order.status === 'active') {
              order.status = 'released'; order.phone = null; order.expire = null;
              await kv.put(p.oid, JSON.stringify(order), {
                metadata: { createdAt: order.createdAt || 0, status: 'released' }
              });
              await removeFromActiveIndex(p.oid);
            }
            p.status = 'available'; p.oid = null; p.expire = null;
          }
        }
        await savePool(pool);
        return jsonResponse({ success: true });
      }

      case 'releasePoolPhone': {
        const phone = url.searchParams.get('phone');
        if (!phone) return jsonResponse({ error: '缺少 phone 参数' }, 400);
        const pool = await getPool();
        const entry = pool.find(p => p.phone === phone);
        if (!entry) return jsonResponse({ error: '号码不在池中' }, 404);
        if (entry.status !== 'in_use') return jsonResponse({ error: '该号码未被占用' }, 400);
        if (entry.oid) {
          const order = await kv.get(entry.oid, { type: 'json' });
          if (order && order.status === 'active') {
            order.status = 'released'; order.phone = null; order.expire = null;
            await kv.put(entry.oid, JSON.stringify(order), {
              metadata: { createdAt: order.createdAt || 0, status: 'released' }
            });
            await removeFromActiveIndex(entry.oid);
          }
        }
        entry.status = 'available'; entry.oid = null; entry.expire = null;
        await savePool(pool);
        return jsonResponse({ success: true });
      }

      case 'logList': {
        const logs = await getLogs();
        return jsonResponse({ logs: logs.reverse() });
      }

      case 'status': {
        const order = await kv.get(oid, { type: 'json' });
        if (!order) return jsonResponse({ status: 'invalid', phone: null, expire: null, code: null });
        if (order.expire && order.status === 'active' && Date.now() >= order.expire) {
          await releaseOrderPhone(order, oid);
          order.status = 'expired'; order.phone = null; order.expire = null;
          await kv.put(oid, JSON.stringify(order), {
            metadata: { createdAt: order.createdAt || 0, status: 'expired' }
          });
          return jsonResponse({ status: 'expired', phone: null, expire: null, code: null });
        }
        return jsonResponse(order);
      }

      case 'getPhone': {
        let order = await kv.get(oid, { type: 'json' });
        if (!order) return jsonResponse({ error: '订单不存在或已失效' }, 404);
        if (order.status === 'done') return jsonResponse({ error: '订单已完成' }, 403);
        if (order.status === 'released') return jsonResponse({ error: '订单已被管理员释放' }, 403);

        if (order.status === 'expired') {
          order.status = 'new'; order.phone = null; order.expire = null; order.code = null; order.fromPool = false;
          await kv.put(oid, JSON.stringify(order), {
            metadata: { createdAt: order.createdAt || 0, status: 'new' }
          });
        }

        if (order.status === 'active' && order.expire && Date.now() < order.expire) {
          return jsonResponse({ phone: order.phone, expire: order.expire });
        }

        if (order.status === 'active' && order.expire && Date.now() >= order.expire) {
          await releaseOrderPhone(order, oid);
          order.status = 'new'; order.phone = null; order.expire = null; order.code = null; order.fromPool = false;
          await kv.put(oid, JSON.stringify(order), {
            metadata: { createdAt: order.createdAt || 0, status: 'new' }
          });
        }

        if (order.phone && order.fromPool) {
          const pool = await getPool();
          const entry = pool.find(p => p.phone === order.phone);
          if (entry && entry.status === 'in_use') {
            entry.status = 'available'; entry.oid = null; entry.expire = null;
            await savePool(pool);
          }
        }

        const tokenStr = await getValidToken();
        const orderSid = order.sid || HAOZHU.sid;

        // 子流程 1：指定手机号
        if (order.assignedPhone) {
          const reqUrl = `https://${HAOZHU.server}/sms/?api=getPhone&token=${tokenStr}&sid=${orderSid}&phone=${encodeURIComponent(order.assignedPhone)}`;
          const phoneResp = await fetchWithTimeout(reqUrl);
          const phoneData = await phoneResp.json();
          if (phoneData.code == 0) {
            const realPhone = phoneData.phone || phoneData.Phone || phoneData.mobile || order.assignedPhone;
            order.phone = realPhone;
            order.expire = Date.now() + PHONE_TTL_MS;
            order.status = 'active';
            order.code = null;
            order.fromPool = false;
            order.phoneAssignedAt = Date.now();
            await kv.put(oid, JSON.stringify(order), {
              metadata: { createdAt: order.createdAt || 0, status: 'active' }
            });
            await updateActiveIndex(oid, realPhone, order.expire);
            return jsonResponse({ phone: realPhone, expire: order.expire });
          }
          return jsonResponse({ error: '获取指定手机号失败：' + (phoneData.msg || '平台无该号或已被占用') }, 400);
        }

        // 子流程 2：号池
        const pool = await getPool();
        const available = pool.filter(p => p.status === 'available');
        if (available.length > 0) {
          const chosen = available[Math.floor(Math.random() * available.length)];
          const phone = chosen.phone;
          const expire = Date.now() + PHONE_TTL_MS;

          try {
            const activateUrl = `https://${HAOZHU.server}/sms/?api=getPhone&token=${tokenStr}&sid=${orderSid}&phone=${phone}`;
            await fetchWithTimeout(activateUrl);
          } catch (e) {}

          chosen.status = 'in_use'; chosen.oid = oid; chosen.expire = expire;
          await savePool(pool);

          const newOrder = {
            ...order, phone, expire, status: 'active', code: null, fromPool: true,
            phoneAssignedAt: Date.now()
          };
          await kv.put(oid, JSON.stringify(newOrder), {
            metadata: { createdAt: newOrder.createdAt || 0, status: 'active' }
          });
          await updateActiveIndex(oid, phone, expire);
          return jsonResponse({ phone, expire });
        }

        // 子流程 3：平台正常取号
        const f = order.filters || {};
        let apiUrl = `https://${HAOZHU.server}/sms/?api=getPhone&token=${tokenStr}&sid=${orderSid}`;
        if (f.ascription) apiUrl += `&ascription=${encodeURIComponent(f.ascription)}`;
        if (f.paragraph)  apiUrl += `&paragraph=${encodeURIComponent(f.paragraph)}`;
        if (f.exclude)    apiUrl += `&exclude=${encodeURIComponent(f.exclude)}`;
        if (f.isp)        apiUrl += `&isp=${encodeURIComponent(f.isp)}`;
        if (f.province)   apiUrl += `&Province=${encodeURIComponent(f.province)}`;
        if (f.uid)        apiUrl += `&uid=${encodeURIComponent(f.uid)}`;

        const phoneResp = await fetchWithTimeout(apiUrl);
        const phoneData = await phoneResp.json();
        if (phoneData.code == 0) {
          const phone = phoneData.phone || phoneData.Phone || phoneData.mobile;
          const newOrder = {
            ...order, phone, expire: Date.now() + PHONE_TTL_MS,
            status: 'active', code: null, fromPool: false,
            phoneAssignedAt: Date.now()
          };
          await kv.put(oid, JSON.stringify(newOrder), {
            metadata: { createdAt: newOrder.createdAt || 0, status: 'active' }
          });
          await updateActiveIndex(oid, phone, newOrder.expire);
          return jsonResponse({ phone, expire: newOrder.expire });
        }
        return jsonResponse({ error: phoneData.msg || '取号失败' }, 500);
      }

      case 'release': {
        const order = await kv.get(oid, { type: 'json' });
        if (!order) return jsonResponse({ error: '订单不存在' }, 404);
        if (order.status === 'done') return jsonResponse({ error: '订单已完成' }, 403);

        await releaseOrderPhone(order, oid);

        order.status = 'new'; order.phone = null; order.expire = null; order.code = null; order.fromPool = false;
        await kv.put(oid, JSON.stringify(order), {
          metadata: { createdAt: order.createdAt || 0, status: 'new' }
        });
        return jsonResponse({ success: true });
      }

      // ============ getSMS：收到验证码时，加入订单索引 ============
      case 'getSMS': {
        const order = await kv.get(oid, { type: 'json' });
        if (!order) return jsonResponse({ error: '订单不存在' }, 404);

        if (order.status === 'active' && order.expire && Date.now() >= order.expire) {
          await releaseOrderPhone(order, oid);
          order.status = 'expired'; order.phone = null; order.expire = null;
          await kv.put(oid, JSON.stringify(order), {
            metadata: { createdAt: order.createdAt || 0, status: 'expired' }
          });
          return jsonResponse({ status: 'expired', code: null });
        }

        if (!order.phone) return jsonResponse({ error: '订单不存在' }, 404);
        if (order.status !== 'active') return jsonResponse({ status: order.status, code: order.code || null });

        const tokenStr = await getValidToken();
        const orderSid = order.sid || HAOZHU.sid;
        const smsResp = await fetchWithTimeout(`https://${HAOZHU.server}/sms/?api=getMessage&token=${tokenStr}&sid=${orderSid}&phone=${order.phone}`);
        const smsData = await smsResp.json();

        if (smsData.code == 0) {
          const raw = smsData.sms || smsData.Sms || smsData.message || smsData.code_text || '';
          if (raw) {
            const match = raw.match(/(?<!\d)(\d{4,6})(?!\d)/);
            if (match) {
              order.code = match[1]; order.status = 'done'; order.doneTime = Date.now();
              await kv.put(oid, JSON.stringify(order), {
                metadata: { createdAt: order.createdAt || 0, status: 'done' }
              });
              await removeFromActiveIndex(oid);
              await addLog(order.phone, oid, 'sms_received');

              // ★ 收到验证码，加入订单索引，列表才会显示
              try {
                await pushToOrderIndex(oid, order.createdAt || Date.now());
              } catch (e) {
                console.error('加入订单索引失败:', e);
              }

              return jsonResponse({ code: match[1], status: 'done' });
            }
          }
        }
        return jsonResponse({ code: null, status: 'active' });
      }

      case 'setPhone': {
        const phone = url.searchParams.get('phone');
        if (!phone) return jsonResponse({ error: '缺少 phone 参数' }, 400);
        const order = { phone, expire: 0, status: 'pending', code: null, fromPool: false, createdAt: Date.now() };
        await kv.put(oid, JSON.stringify(order), {
          metadata: { createdAt: order.createdAt, status: 'pending' }
        });
        return jsonResponse({ success: true });
      }

      default:
        return jsonResponse({ error: '未知操作' }, 400);
    }

  } catch (e) {
    return new Response(JSON.stringify({ error: 'Worker 内部异常: ' + e.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      }
    });
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
    }
  });
}
