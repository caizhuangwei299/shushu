export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const action = url.searchParams.get('action');
  const oid = url.searchParams.get('oid');
  const sid = url.searchParams.get('sid') || '24085';

  // 写死的 API 账号密码
  const apiUser = '0d1f0214da0eecc58ba00012056abf8ceba61d3522e9d1b4b4882aa28892c374';
  const apiPass = '4e32e4470173719ea41f7388d6f3fabfbd0a19edc3c1851c5921060810d0571c';

  // 所有无需 oid 的接口
  const poolActions = [
    'addPhone', 'removePhone', 'poolList', 'resetPool', 'releasePoolPhone', 'logList',
    'getBalance', 'lockOrder', 'blockPhone',
    'generateCard', 'activateCard', 'verifyCard', 'cardList', 'deleteCard',
    'createOrder',
    'listActiveOrders',
    'releaseAllOrders',
    'cancelRecvPhone'
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

  const kv = env.ORDERS;
  const POOL_KEY = 'phone_pool';
  const LOG_KEY = 'phone_logs';
  const CARD_KEY = 'card_keys';

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

  function generateCardKey() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const segment = () => {
      let s = '';
      for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
      return s;
    };
    return `HZ-${segment()}-${segment()}`;
  }

  // Token 管理
  let tokenData = await kv.get('__token_data__', { type: 'json' });
  let tokenStr = tokenData ? tokenData.token : null;
  let tokenExpiry = tokenData ? tokenData.expire : 0;
  const tokenApiUser = tokenData ? tokenData.apiUser : null;
  const tokenApiPass = tokenData ? tokenData.apiPass : null;

  const needLogin = !tokenStr || Date.now() >= tokenExpiry - 300000 || tokenApiUser !== apiUser || tokenApiPass !== apiPass;

  if (needLogin) {
    const loginResp = await fetch(`https://${HAOZHU.server}/sms/?api=login&user=${HAOZHU.user}&pass=${HAOZHU.pass}`);
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
      return jsonResponse({ error: '登录失败：' + (loginData.msg || '') }, 500);
    }
  }

  // ========== 辅助函数：释放单个订单 ==========
  async function releaseOrderByOid(oid) {
    let order = await kv.get(oid, { type: 'json' });
    if (!order) return { success: false, error: '订单不存在' };
    if (order.status === 'done') return { success: false, error: '订单已完成，无法释放' };
    if (order.status === 'released') return { success: false, error: '订单已被释放过' };

    if (order.phone && order.fromPool) {
      let pool = await getPool();
      const entry = pool.find(p => p.phone === order.phone);
      if (entry && entry.status === 'in_use') {
        entry.status = 'available';
        entry.oid = null;
        entry.expire = null;
        await savePool(pool);
      }
    } else if (order.phone) {
      try {
        await fetch(`https://${HAOZHU.server}/sms/?api=cancelRecv&token=${tokenStr}&sid=${HAOZHU.sid}&phone=${order.phone}`);
      } catch(e) {}
    }

    order.status = 'released';
    order.phone = null;
    order.expire = null;
    order.code = null;
    await kv.put(oid, JSON.stringify(order));
    return { success: true };
  }

  try {
    switch (action) {

      // ========== 指定释放手机号 ==========
      case 'cancelRecvPhone': {
        const phone = url.searchParams.get('phone');
        if (!phone) return jsonResponse({ error: '缺少 phone 参数' }, 400);

        try {
          const cancelUrl = `https://${HAOZHU.server}/sms/?api=cancelRecv&token=${tokenStr}&sid=${HAOZHU.sid}&phone=${encodeURIComponent(phone)}`;
          const cancelResp = await fetch(cancelUrl);
          const cancelData = await cancelResp.json();

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
              }
            }
            pEntry.status = 'available';
            pEntry.oid = null;
            pEntry.expire = null;
            await savePool(pool);
          }

          if (cancelData.code == 0 || cancelData.msg?.includes('成功')) {
            return jsonResponse({ success: true, msg: cancelData.msg || '释放成功' });
          } else {
            return jsonResponse({ success: false, error: cancelData.msg || '平台释放失败' }, 400);
          }
        } catch (e) {
          return jsonResponse({ error: '请求接码平台失败: ' + e.message }, 500);
        }
      }

      // ========== 列出活跃订单 ==========
      case 'listActiveOrders': {
        const keys = await kv.list();
        const orders = [];
        for (const key of keys.keys) {
          if (key.name.startsWith('__') || key.name === POOL_KEY || key.name === LOG_KEY || key.name === CARD_KEY) continue;
          const order = await kv.get(key.name, { type: 'json' });
          if (order && order.status === 'active' && order.phone) {
            orders.push({ oid: key.name, phone: order.phone });
          }
        }
        return jsonResponse({ orders });
      }

      // ========== 一键释放全部活跃订单 ==========
      case 'releaseAllOrders': {
        const keys = await kv.list();
        const results = [];
        for (const key of keys.keys) {
          if (key.name.startsWith('__') || key.name === POOL_KEY || key.name === LOG_KEY || key.name === CARD_KEY) continue;
          const order = await kv.get(key.name, { type: 'json' });
          if (order && order.status === 'active') {
            const result = await releaseOrderByOid(key.name);
            results.push({ oid: key.name, success: result.success, error: result.error });
          }
        }
        const successCount = results.filter(r => r.success).length;
        return jsonResponse({ success: true, released: successCount, total: results.length, details: results });
      }

      // ========== 创建订单（支持普通创建与指定号码创建） ==========
      case 'createOrder': {
        if (!oid) return jsonResponse({ error: '缺少订单ID' }, 400);
        let existing = await kv.get(oid, { type: 'json' });
        if (existing) return jsonResponse({ error: '订单已存在' }, 400);

        const specifiedPhone = url.searchParams.get('phone');

        // 如果传入了指定手机号，直接通过平台 API 取指定号码
        if (specifiedPhone) {
          const reqUrl = `https://${HAOZHU.server}/sms/?api=getPhone&token=${tokenStr}&sid=${HAOZHU.sid}&phone=${encodeURIComponent(specifiedPhone)}`;
          const phoneResp = await fetch(reqUrl);
          const phoneData = await phoneResp.json();

          if (phoneData.code == 0) {
            const realPhone = phoneData.phone || phoneData.Phone || phoneData.mobile || specifiedPhone;
            const newOrder = {
              status: 'active',
              phone: realPhone,
              expire: Date.now() + 120 * 1000,
              code: null,
              fromPool: false,
              filters: {}
            };
            await kv.put(oid, JSON.stringify(newOrder));
            return jsonResponse({ success: true, phone: realPhone });
          } else {
            return jsonResponse({ error: '指定号码取号失败：' + (phoneData.msg || '未知错误') }, 400);
          }
        }

        // 普通预创建订单逻辑
        const ascription = url.searchParams.get('ascription') || '';
        const paragraph  = url.searchParams.get('paragraph')  || '';
        const exclude    = url.searchParams.get('exclude')    || '';
        const isp        = url.searchParams.get('isp')        || '';
        const province   = url.searchParams.get('Province')   || '';

        const newOrder = {
          status: 'new',
          phone: null,
          expire: null,
          code: null,
          fromPool: false,
          filters: { ascription, paragraph, exclude, isp, province }
        };
        await kv.put(oid, JSON.stringify(newOrder));
        return jsonResponse({ success: true });
      }

      // ========== 卡密系统 ==========
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

      // ========== 查询余额 ==========
      case 'getBalance': {
        const balanceResp = await fetch(`https://${HAOZHU.server}/sms/?api=getSummary&token=${tokenStr}`);
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

      // ========== 拉黑手机号 ==========
      case 'blockPhone': {
        const phone = url.searchParams.get('phone');
        if (!phone) return jsonResponse({ error: '缺少 phone 参数' }, 400);
        const blockResp = await fetch(`https://${HAOZHU.server}/sms/?api=addBlacklist&token=${tokenStr}&sid=${HAOZHU.sid}&phone=${phone}`);
        const blockData = await blockResp.json();
        if (blockData.code == 0) {
          let pool = await getPool();
          pool = pool.filter(p => p.phone !== phone);
          await savePool(pool);
          return jsonResponse({ success: true });
        }
        return jsonResponse({ error: blockData.msg || '拉黑失败' });
      }

      // ========== 管理员强制释放订单 ==========
      case 'lockOrder': {
        if (!oid) return jsonResponse({ error: '缺少订单ID' }, 400);
        const result = await releaseOrderByOid(oid);
        if (result.success) {
          return jsonResponse({ success: true });
        } else {
          return jsonResponse({ error: result.error }, 400);
        }
      }

      // ========== 号码池管理 ==========
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
          }
        }
        entry.status = 'available'; entry.oid = null; entry.expire = null;
        await savePool(pool);
        return jsonResponse({ success: true });
      }

      // ========== 日志列表 ==========
      case 'logList': {
        const logs = await getLogs();
        return jsonResponse({ logs: logs.reverse() });
      }

      // ========== 订单状态 ==========
      case 'status': {
        let order = await kv.get(oid, { type: 'json' });
        if (!order) {
          return jsonResponse({ status: 'invalid', phone: null, expire: null, code: null });
        }
        if (order.expire && order.status === 'active' && Date.now() >= order.expire) {
          if (order.fromPool && order.phone) {
            let pool = await getPool();
            const entry = pool.find(p => p.phone === order.phone);
            if (entry && entry.status === 'in_use') {
              entry.status = 'available'; entry.oid = null; entry.expire = null;
              await savePool(pool);
            }
          }
          order.status = 'expired';
          await kv.put(oid, JSON.stringify(order));
        }
        return jsonResponse(order);
      }

      // ========== 获取手机号 ==========
      case 'getPhone': {
        let order = await kv.get(oid, { type: 'json' });
        if (!order) {
          return jsonResponse({ error: '订单不存在或已失效' }, 404);
        }
        if (order.status === 'done') return jsonResponse({ error: '订单已完成' }, 403);
        if (order.status === 'released') return jsonResponse({ error: '订单已被管理员释放' }, 403);
        if (order.status === 'active' && order.expire && Date.now() < order.expire) {
          return jsonResponse({ phone: order.phone, expire: order.expire });
        }

        if (order.phone && order.fromPool) {
          let pool = await getPool();
          const entry = pool.find(p => p.phone === order.phone);
          if (entry && entry.status === 'in_use') {
            entry.status = 'available'; entry.oid = null; entry.expire = null;
            await savePool(pool);
          }
        }

        let pool = await getPool();
        const available = pool.filter(p => p.status === 'available');
        if (available.length > 0) {
          const chosen = available[Math.floor(Math.random() * available.length)];
          const phone = chosen.phone;
          const expire = Date.now() + 120 * 1000;

          try {
            const activateUrl = `https://${HAOZHU.server}/sms/?api=getPhone&token=${tokenStr}&sid=${HAOZHU.sid}&phone=${phone}`;
            await fetch(activateUrl);
          } catch (e) {}

          chosen.status = 'in_use';
          chosen.oid = oid;
          chosen.expire = expire;
          await savePool(pool);

          const newOrder = { phone, expire, status: 'active', code: null, fromPool: true, filters: order.filters || {} };
          await kv.put(oid, JSON.stringify(newOrder));
          return jsonResponse({ phone, expire });
        }

        const f = order.filters || {};
        let apiUrl = `https://${HAOZHU.server}/sms/?api=getPhone&token=${tokenStr}&sid=${HAOZHU.sid}`;
        if (f.ascription) apiUrl += `&ascription=${encodeURIComponent(f.ascription)}`;
        if (f.paragraph)  apiUrl += `&paragraph=${encodeURIComponent(f.paragraph)}`;
        if (f.exclude)    apiUrl += `&exclude=${encodeURIComponent(f.exclude)}`;
        if (f.isp)        apiUrl += `&isp=${encodeURIComponent(f.isp)}`;
        if (f.province)   apiUrl += `&Province=${encodeURIComponent(f.province)}`;

        const phoneResp = await fetch(apiUrl);
        const phoneData = await phoneResp.json();
        if (phoneData.code == 0) {
          const phone = phoneData.phone || phoneData.Phone || phoneData.mobile;
          const newOrder = {
            phone,
            expire: Date.now() + 120 * 1000,
            status: 'active',
            code: null,
            fromPool: false,
            filters: f
          };
          await kv.put(oid, JSON.stringify(newOrder));
          return jsonResponse({ phone, expire: newOrder.expire });
        }
        return jsonResponse({ error: phoneData.msg || '取号失败' }, 500);
      }

      // ========== 释放（买家释放） ==========
      case 'release': {
        let order = await kv.get(oid, { type: 'json' });
        if (!order) return jsonResponse({ error: '订单不存在' }, 404);
        if (order.status === 'done') return jsonResponse({ error: '订单已完成' }, 403);

        if (order.phone && order.fromPool) {
          let pool = await getPool();
          const entry = pool.find(p => p.phone === order.phone);
          if (entry) {
            entry.status = 'available'; entry.oid = null; entry.expire = null;
            await savePool(pool);
          }
        } else if (order.phone) {
          try { await fetch(`https://${HAOZHU.server}/sms/?api=cancelRecv&token=${tokenStr}&sid=${HAOZHU.sid}&phone=${order.phone}`); } catch(e) {}
        }

        order.status = 'new'; order.phone = null; order.expire = null; order.code = null;
        await kv.put(oid, JSON.stringify(order));
        return jsonResponse({ success: true });
      }

      // ========== 获取验证码 ==========
      case 'getSMS': {
        const order = await kv.get(oid, { type: 'json' });
        if (!order || !order.phone) return jsonResponse({ error: '订单不存在' }, 404);

        const smsResp = await fetch(`https://${HAOZHU.server}/sms/?api=getMessage&token=${tokenStr}&sid=${HAOZHU.sid}&phone=${order.phone}`);
        const smsData = await smsResp.json();

        if (smsData.code == 0) {
          const raw = smsData.sms || smsData.Sms || smsData.message || smsData.code_text || '';
          if (raw) {
            const digits = raw.replace(/\D/g, '');
            if (digits.length >= 4) {
              order.code = raw;
              order.status = 'done';
              await kv.put(oid, JSON.stringify(order));
              await addLog(order.phone, oid, 'sms_received');
              return jsonResponse({ code: raw, status: 'done' });
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
    return jsonResponse({ error: e.message }, 500);
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
