// ============ 全局常量 ============
const PHONE_TTL_MS = 90 * 1000;  // 手机号有效期：90 秒
const ACTIVE_INDEX_KEY = '__active_orders__'; // 活跃订单索引键

// ============ 带超时的 fetch，防止第三方接口卡死导致 Worker 超时 ============
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

  // 1. 处理浏览器的 OPTIONS 预检请求
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

  // 2. 全局防护罩
  try {
    const kv = env.ORDERS;
    if (!kv) {
      throw new Error('严重错误：后端 KV 数据库 (ORDERS) 未绑定，请去 Cloudflare 后台重新绑定并部署！');
    }

    const POOL_KEY = 'phone_pool';
    const LOG_KEY = 'phone_logs';
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
      'cancelRecvPhone', 'saveApiConfig'
    ];
    if (!oid && !poolActions.includes(action)) {
      return jsonResponse({ error: '缺少订单ID' }, 400);
    }

    const HAOZHU = {
      server: 'api.haozhuma.com',
      user: apiUser,
      pass: apiPass,
      sid: sid
    };

    async function getPool() { const p = await kv.get(POOL_KEY, { type: 'json' }); return p || []; }
    async function savePool(pool) { await kv.put(POOL_KEY, JSON.stringify(pool)); }

    async function getLogs() { const logs = await kv.get(LOG_KEY, { type: 'json' }); return logs || []; }
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

    // ============ 活跃订单索引维护 ============
    async function updateActiveIndex(oid, phone, expire) {
      let index = await kv.get(ACTIVE_INDEX_KEY, { type: 'json' }) || {};
      index[oid] = { oid, phone, expire };
      await kv.put(ACTIVE_INDEX_KEY, JSON.stringify(index));
    }

    async function removeFromActiveIndex(oid) {
      let index = await kv.get(ACTIVE_INDEX_KEY, { type: 'json' }) || {};
      if (index[oid]) {
        delete index[oid];
        await kv.put(ACTIVE_INDEX_KEY, JSON.stringify(index));
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
      if (!HAOZHU.user || !HAOZHU.pass) {
        throw new Error('未配置接码平台账号密码，请先在管理面板的系统配置中保存');
      }

      let tokenData = await kv.get('__token_data__', { type: 'json' });
      let tokenStr = tokenData ? tokenData.token : null;
      let tokenExpiry = tokenData ? tokenData.expire : 0;
      const tokenApiUser = tokenData ? tokenData.apiUser : null;
      const tokenApiPass = tokenData ? tokenData.apiPass : null;

      const needLogin = !tokenStr || Date.now() >= tokenExpiry - 300000 || tokenApiUser !== HAOZHU.user || tokenApiPass !== HAOZHU.pass;

      if (needLogin) {
        const loginResp = await fetchWithTimeout(`https://${HAOZHU.server}/sms/?api=login&user=${HAOZHU.user}&pass=${HAOZHU.pass}`);
        const loginData = await loginResp.json();
        if (loginData.code == 0) {
          tokenStr = loginData.token || loginData.Token || loginData.access_token;
          tokenExpiry = Date.now() + 3500000;
          await kv.put('__token_data__', JSON.stringify({
            token: tokenStr,
            expire: tokenExpiry,
            apiUser: HAOZHU.user,
            apiPass: HAOZHU.pass
          }));
        } else {
          throw new Error('接码平台登录失败：' + (loginData.msg || ''));
        }
      }
      return tokenStr;
    }

    // ============ 统一释放订单手机号的辅助函数 ============
    async function releaseOrderPhone(order, oid) {
      if (!order || !order.phone) return;
      if (order.fromPool) {
        let pool = await getPool();
        const entry = pool.find(p => p.phone === order.phone);
        if (entry && entry.status === 'in_use') {
          entry.status = 'available';
          entry.oid = null;
          entry.expire = null;
          await savePool(pool);
        }
      } else {
        try {
          const tokenStr = await getValidToken();
          const orderSid = order.sid || HAOZHU.sid;
          await fetchWithTimeout(`https://${HAOZHU.server}/sms/?api=cancelRecv&token=${tokenStr}&sid=${orderSid}&phone=${order.phone}`);
        } catch(e) { console.error('释放号码失败:', e); }
      }
      // 从活跃索引中移除
      if (oid) await removeFromActiveIndex(oid);
    }

    async function releaseOrderByOid(oid) {
      let order = await kv.get(oid, { type: 'json' });
      if (!order) return { success: false, error: '订单不存在' };
      if (order.status === 'done') return { success: false, error: '订单已完成，无法释放' };
      if (order.status === 'released') return { success: false, error: '订单已被释放过' };

      await releaseOrderPhone(order, oid);

      order.status = 'released';
      order.phone = null;
      order.expire = null;
      order.code = null;
      await kv.put(oid, JSON.stringify(order));
      return { success: true };
    }

    // ====== 核心业务逻辑 ======
    switch (action) {
      case 'saveApiConfig': {
        const newUser = url.searchParams.get('apiUser');
        const newPass = url.searchParams.get('apiPass');
        const newSid = url.searchParams.get('sid');
        
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
          
          // 使用带超时的 fetch
          const cancelResp = await fetchWithTimeout(cancelUrl);
          const cancelData = await cancelResp.json();

          // 🟢 修复：只有平台明确表示释放成功（或返回成功），才修改本地状态
          if (cancelData.code == 0 || cancelData.msg?.includes('成功')) {
            let pool = await getPool();
            const pEntry = pool.find(p => p.phone === phone);
            if (pEntry && pEntry.status === 'in_use') {
              if (pEntry.oid) {
                let order = await kv.get(pEntry.oid, { type: 'json' });
                if (order && order.status === 'active') {
                  order.status = 'released';
                  order.phone = null;
                  order.expire = null;
                  await kv.put(pEntry.oid, JSON.stringify(order));
                  await removeFromActiveIndex(pEntry.oid);
                }
              }
              pEntry.status = 'available';
              pEntry.oid = null;
              pEntry.expire = null;
              await savePool(pool);
            }
            return jsonResponse({ success: true, msg: cancelData.msg || '释放成功' });
          } else {
            return jsonResponse({ success: false, error: cancelData.msg || '平台释放失败' }, 400);
          }
        } catch (e) {
          return jsonResponse({ error: '请求接码平台失败: ' + e.message }, 500);
        }
      }

      case 'listActiveOrders': {
        // 🟢 修复：彻底抛弃全表扫描，直接读取内存级索引
        let activeIndex = await kv.get(ACTIVE_INDEX_KEY, { type: 'json' }) || {};
        const now = Date.now();
        let changed = false;
        const orders = [];

        for (const oid in activeIndex) {
          const item = activeIndex[oid];
          if (item.expire && now >= item.expire) {
            // 惰性清理已过期的活跃订单
            delete activeIndex[oid];
            changed = true;
          } else {
            orders.push(item);
          }
        }

        if (changed) await kv.put(ACTIVE_INDEX_KEY, JSON.stringify(activeIndex));

        return jsonResponse({ orders });
      }

      case 'listAllOrders': {
        const cursor = url.searchParams.get('cursor') || null;
        const limit = Math.min(parseInt(url.searchParams.get('limit')) || 100, 200);

        const listOptions = { limit, reverse: true };
        if (cursor) listOptions.cursor = cursor;

        const listRes = await kv.list(listOptions);

        const validKeys = listRes.keys.filter(k =>
          !k.name.startsWith('__') &&
          k.name !== POOL_KEY &&
          k.name !== LOG_KEY &&
          k.name !== CARD_KEY
        );

        const BATCH_SIZE = 50;
        const orders = [];
        for (let i = 0; i < validKeys.length; i += BATCH_SIZE) {
          const batch = validKeys.slice(i, i + BATCH_SIZE);
          const batchResults = await Promise.all(
            batch.map(k =>
              kv.get(k.name, { type: 'json' }).catch(e => {
                console.error(`读取订单 ${k.name} 失败:`, e);
                return null;
              })
            )
          );
          batch.forEach((k, idx) => {
            const order = batchResults[idx];
            if (order) {
              orders.push({
                oid: k.name,
                phone: order.phone || '---',
                assignedPhone: order.assignedPhone || '',
                status: order.status || 'new',
                code: order.code || '',
                expire: order.expire || null,
                doneTime: order.doneTime || null,
              });
            }
          });
        }

        orders.sort((a, b) => b.oid.localeCompare(a.oid));

        return jsonResponse({
          orders,
          cursor: listRes.cursor || null,
          list_complete: !!listRes.list_complete,
        });
      }

      case 'releaseAllOrders': {
        let activeIndex = await kv.get(ACTIVE_INDEX_KEY, { type: 'json' }) || {};
        const activeOids = Object.keys(activeIndex);
        const results = [];

        for (const oid of activeOids) {
          const result = await releaseOrderByOid(oid);
          results.push({ oid, success: result.success, error: result.error });
        }

        const successCount = results.filter(r => r.success).length;
        return jsonResponse({ success: true, released: successCount, total: results.length, details: results });
      }

      case 'createOrder': {
        if (!oid) return jsonResponse({ error: '缺少订单ID' }, 400);
        let existing = await kv.get(oid, { type: 'json' });
        if (existing) return jsonResponse({ error: '订单已存在' }, 400);

        const specifiedPhone = url.searchParams.get('phone') || '';
        const ascription = url.searchParams.get('ascription') || '';
        const paragraph  = url.searchParams.get('paragraph')  || '';
        const exclude    = url.searchParams.get('exclude')    || '';
        const isp        = url.searchParams.get('isp')        || '';
        const province   = url.searchParams.get('Province')   || '';
        const uid        = url.searchParams.get('uid')        || ''; 

        const newOrder = {
          status: 'new',
          sid: sid,
          assignedPhone: specifiedPhone,
          phone: null,
          expire: null,
          code: null,
          fromPool: false,
          filters: { ascription, paragraph, exclude, isp, province, uid } 
        };
        await kv.put(oid, JSON.stringify(newOrder));
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
          cards.push({
            key,
            type,
            duration,
            activated: false,
            activated_at: null,
            expire_at: null,
            created_at: Date.now()
          });
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
        card.activated = true;
        card.activated_at = now;
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
          let bal = balanceData.balance || balanceData.summary || balanceData.money ||
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
        if (result.success) {
          return jsonResponse({ success: true });
        } else {
          return jsonResponse({ error: result.error }, 400);
        }
      }

      case 'poolList': { const pool = await getPool(); return jsonResponse({ pool }); }
      case 'addPhone': {
        const phone = url.searchParams.get('phone');
        if (!phone) return jsonResponse({ error: '缺少 phone 参数' }, 400);
        let pool = await getPool();
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
        let pool = await getPool();
        for (const p of pool) {
          if (p.status === 'in_use' && p.oid) {
            let order = await kv.get(p.oid, { type: 'json' });
            if (order && order.status === 'active') {
              order.status = 'released'; order.phone = null; order.expire = null;
              await kv.put(p.oid, JSON.stringify(order));
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
        let pool = await getPool();
        const entry = pool.find(p => p.phone === phone);
        if (!entry) return jsonResponse({ error: '号码不在池中' }, 404);
        if (entry.status !== 'in_use') return jsonResponse({ error: '该号码未被占用' }, 400);
        if (entry.oid) {
          let order = await kv.get(entry.oid, { type: 'json' });
          if (order && order.status === 'active') {
            order.status = 'released'; order.phone = null; order.expire = null;
            await kv.put(entry.oid, JSON.stringify(order));
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

      // ============ status：核心改动 ============
      case 'status': {
        let order = await kv.get(oid, { type: 'json' });
        if (!order) {
          return jsonResponse({ status: 'invalid', phone: null, expire: null, code: null });
        }
        // 惰性过期检测：若 active 且已超时 → 释放号码 + 标记 expired
        if (order.expire && order.status === 'active' && Date.now() >= order.expire) {
          await releaseOrderPhone(order, oid);
          order.status = 'expired';
          order.phone = null;
          order.expire = null;
          await kv.put(oid, JSON.stringify(order));
          return jsonResponse({ status: 'expired', phone: null, expire: null, code: null });
        }
        return jsonResponse(order);
      }

      // ============ getPhone：核心改动 ============
      case 'getPhone': {
        let order = await kv.get(oid, { type: 'json' });
        if (!order) {
          return jsonResponse({ error: '订单不存在或已失效' }, 404);
        }
        if (order.status === 'done') return jsonResponse({ error: '订单已完成' }, 403);
        if (order.status === 'released') return jsonResponse({ error: '订单已被管理员释放' }, 403);
        
        // 场景 A：expired 状态 → 重置为 new，允许用户拿新号
        if (order.status === 'expired') {
          order.status = 'new';
          order.phone = null;
          order.expire = null;
          order.code = null;
          order.fromPool = false;
          await kv.put(oid, JSON.stringify(order));
        }
        
        // 场景 B：active 且未过期 → 复用现有号码
        if (order.status === 'active' && order.expire && Date.now() < order.expire) {
          return jsonResponse({ phone: order.phone, expire: order.expire });
        }
        
        // 场景 C：active 但已过期 → 释放并重置
        if (order.status === 'active' && order.expire && Date.now() >= order.expire) {
          await releaseOrderPhone(order, oid);
          order.status = 'new';
          order.phone = null;
          order.expire = null;
          order.code = null;
          order.fromPool = false;
          await kv.put(oid, JSON.stringify(order));
        }

        // 场景 D：旧号还在池里但订单已不是 active → 释放
        if (order.phone && order.fromPool) {
          let pool = await getPool();
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
            await kv.put(oid, JSON.stringify(order));
            await updateActiveIndex(oid, realPhone, order.expire); // 写入活跃索引
            return jsonResponse({ phone: realPhone, expire: order.expire });
          } else {
            return jsonResponse({ error: '获取指定手机号失败：' + (phoneData.msg || '平台无该号或已被占用') }, 400);
          }
        }

        // 子流程 2：号池分配
        let pool = await getPool();
        const available = pool.filter(p => p.status === 'available');
        if (available.length > 0) {
          const chosen = available[Math.floor(Math.random() * available.length)];
          const phone = chosen.phone;
          const expire = Date.now() + PHONE_TTL_MS;

          try {
            const activateUrl = `https://${HAOZHU.server}/sms/?api=getPhone&token=${tokenStr}&sid=${orderSid}&phone=${phone}`;
            await fetchWithTimeout(activateUrl);
          } catch (e) {}

          chosen.status = 'in_use';
          chosen.oid = oid;
          chosen.expire = expire;
          await savePool(pool);

          const newOrder = { 
            ...order,
            phone, 
            expire, 
            status: 'active', 
            code: null, 
            fromPool: true 
          };
          await kv.put(oid, JSON.stringify(newOrder));
          await updateActiveIndex(oid, phone, expire); // 写入活跃索引
          return jsonResponse({ phone, expire });
        }

        // 子流程 3：调平台正常取号
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
            ...order,
            phone,
            expire: Date.now() + PHONE_TTL_MS,
            status: 'active',
            code: null,
            fromPool: false
          };
          await kv.put(oid, JSON.stringify(newOrder));
          await updateActiveIndex(oid, phone, newOrder.expire); // 写入活跃索引
          return jsonResponse({ phone, expire: newOrder.expire });
        }
        return jsonResponse({ error: phoneData.msg || '取号失败' }, 500);
      }

      // ============ release：复用辅助函数 ============
      case 'release': {
        let order = await kv.get(oid, { type: 'json' });
        if (!order) return jsonResponse({ error: '订单不存在' }, 404);
        if (order.status === 'done') return jsonResponse({ error: '订单已完成' }, 403);

        await releaseOrderPhone(order, oid);

        order.status = 'new';
        order.phone = null;
        order.expire = null;
        order.code = null;
        order.fromPool = false;
        await kv.put(oid, JSON.stringify(order));
        return jsonResponse({ success: true });
      }

      // ============ getSMS：加入惰性过期检测与精准提取 ============
      case 'getSMS': {
        const order = await kv.get(oid, { type: 'json' });
        if (!order) return jsonResponse({ error: '订单不存在' }, 404);
        
        // 惰性过期：先释放，再返回 expired 状态
        if (order.status === 'active' && order.expire && Date.now() >= order.expire) {
          await releaseOrderPhone(order, oid);
          order.status = 'expired';
          order.phone = null;
          order.expire = null;
          await kv.put(oid, JSON.stringify(order));
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
            // 🟢 精准提取 4-6 位独立数字验证码
            const match = raw.match(/(?<!\d)(\d{4,6})(?!\d)/);
            if (match) {
              order.code = match[1];
              order.status = 'done';
              order.doneTime = Date.now();
              await kv.put(oid, JSON.stringify(order));
              
              // 订单完成，从活跃列表中移除
              await removeFromActiveIndex(oid);
              await addLog(order.phone, oid, 'sms_received');
              
              return jsonResponse({ code: match[1], status: 'done' });
            }
          }
        }
        return jsonResponse({ code: null, status: 'active' });
      }

      case 'setPhone': {
        const phone = url.searchParams.get('phone');
        if (!phone) return jsonResponse({ error: '缺少 phone 参数' }, 400);
        const order = { phone, expire: 0, status: 'pending', code: null, fromPool: false };
        await kv.put(oid, JSON.stringify(order));
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
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

// 标准响应函数
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
