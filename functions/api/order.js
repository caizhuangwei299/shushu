// ============ 全局常量 ============
const PHONE_TTL_MS = 180 * 1000;  // 手机号有效期：180 秒

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
    const DB = env.DB;
    if (!DB) throw new Error('严重错误：D1 数据库 (DB) 未绑定');

    // ===== 配置读写工具（替代 __api_config__ / __token_data__）=====
    async function getConfig(key) {
      const row = await DB.prepare('SELECT value FROM kv_store WHERE key = ?').bind(key).first();
      return row ? JSON.parse(row.value) : null;
    }
    async function putConfig(key, obj) {
      await DB.prepare(
        'INSERT INTO kv_store (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).bind(key, JSON.stringify(obj)).run();
    }
    async function deleteConfig(key) {
      await DB.prepare('DELETE FROM kv_store WHERE key = ?').bind(key).run();
    }

    const apiCfg = await getConfig('__api_config__') || {};
    const apiUser = apiCfg.user || '';
    const apiPass = apiCfg.pass || '';
    const sid = url.searchParams.get('sid') || apiCfg.sid || '24085';

    const poolActions = [
      'addPhone', 'removePhone', 'poolList', 'resetPool', 'releasePoolPhone', 'logList',
      'getBalance', 'lockOrder', 'blockPhone',
      'generateCard', 'activateCard', 'verifyCard', 'cardList', 'deleteCard',
      'createOrder', 'listActiveOrders', 'listAllOrders', 'releaseAllOrders',
      'cancelRecvPhone', 'saveApiConfig', 'getApiConfig', 'rebuildOrderIndex'
    ];
    if (!oid && !poolActions.includes(action)) {
      return jsonResponse({ error: '缺少订单ID' }, 400);
    }

    const HAOZHU = { server: 'api.haozhuma.com', user: apiUser, pass: apiPass, sid };

    // ===== 订单读写 =====
    async function getOrder(oid) {
      const row = await DB.prepare('SELECT * FROM orders WHERE oid = ?').bind(oid).first();
      if (!row) return null;
      return {
        status: row.status,
        sid: row.sid,
        assignedPhone: row.assigned_phone,
        phone: row.phone,
        expire: row.expire,
        code: row.code,
        fromPool: !!row.from_pool,
        createdAt: row.created_at,
        doneTime: row.done_time,
        phoneAssignedAt: row.phone_assigned_at,
        filters: row.filters_json ? JSON.parse(row.filters_json) : {}
      };
    }

    async function saveOrder(oid, order) {
      await DB.prepare(`
        INSERT INTO orders (oid, status, sid, assigned_phone, phone, expire, code, from_pool,
                            created_at, done_time, phone_assigned_at, filters_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(oid) DO UPDATE SET
          status = excluded.status,
          sid = excluded.sid,
          assigned_phone = excluded.assigned_phone,
          phone = excluded.phone,
          expire = excluded.expire,
          code = excluded.code,
          from_pool = excluded.from_pool,
          done_time = excluded.done_time,
          phone_assigned_at = excluded.phone_assigned_at,
          filters_json = excluded.filters_json
      `).bind(
        oid,
        order.status || 'new',
        order.sid || null,
        order.assignedPhone || null,
        order.phone || null,
        order.expire || null,
        order.code || null,
        order.fromPool ? 1 : 0,
        order.createdAt || 0,
        order.doneTime || null,
        order.phoneAssignedAt || null,
        order.filters ? JSON.stringify(order.filters) : null
      ).run();
    }

    // ===== 手机池 =====
    async function getPool() {
      const { results } = await DB.prepare('SELECT * FROM phone_pool').all();
      return results.map(r => ({
        phone: r.phone,
        status: r.status,
        oid: r.oid,
        expire: r.expire
      }));
    }

    // ===== 卡密 =====
    async function getCards() {
      const { results } = await DB.prepare('SELECT * FROM cards').all();
      return results.map(r => ({
        key: r.key,
        type: r.type,
        duration: r.duration,
        activated: !!r.activated,
        activated_at: r.activated_at,
        expire_at: r.expire_at,
        created_at: r.created_at
      }));
    }

    // ===== 活跃订单索引 =====
    async function updateActiveIndex(oid, phone, expire) {
      await DB.prepare(
        'INSERT INTO active_orders (oid, phone, expire) VALUES (?, ?, ?) ' +
        'ON CONFLICT(oid) DO UPDATE SET phone = excluded.phone, expire = excluded.expire'
      ).bind(oid, phone, expire).run();
    }
    async function removeFromActiveIndex(oid) {
      await DB.prepare('DELETE FROM active_orders WHERE oid = ?').bind(oid).run();
    }

    // ===== 日志 =====
    async function addLog(phone, oid, action) {
      if (action !== 'sms_received') return;
      await DB.batch([
        DB.prepare(
          'INSERT INTO phone_logs (phone, oid, action, time) VALUES (?, ?, ?, ?)'
        ).bind(phone, oid, action, new Date().toISOString()),
        DB.prepare(
          'DELETE FROM phone_logs WHERE id NOT IN (SELECT id FROM phone_logs ORDER BY id DESC LIMIT 100)'
        )
      ]);
    }

    // ===== 卡密生成 =====
    function generateCardKey() {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const segment = () => {
        let s = '';
        for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
        return s;
      };
      return `HZ-${segment()}-${segment()}`;
    }

    // ===== Token =====
    async function getValidToken() {
      if (!HAOZHU.user || !HAOZHU.pass) throw new Error('未配置接码平台账号密码');

      const tokenData = await getConfig('__token_data__');
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
          await putConfig('__token_data__', {
            token: tokenStr, expire: tokenExpiry, apiUser: HAOZHU.user, apiPass: HAOZHU.pass
          });
        } else {
          throw new Error('接码平台登录失败：' + (loginData.msg || ''));
        }
      }
      return tokenStr;
    }

    // ===== 释放订单号码 =====
    async function releaseOrderPhone(order, oid) {
      if (!order || !order.phone) return;
      if (order.fromPool) {
        await DB.prepare(
          "UPDATE phone_pool SET status = 'available', oid = NULL, expire = NULL WHERE phone = ? AND status = 'in_use'"
        ).bind(order.phone).run();
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
      const order = await getOrder(oid);
      if (!order) return { success: false, error: '订单不存在' };
      if (order.status === 'done') return { success: false, error: '订单已完成，无法释放' };
      if (order.status === 'released') return { success: false, error: '订单已被释放过' };

      await releaseOrderPhone(order, oid);
      await DB.prepare(
        "UPDATE orders SET status = 'released', phone = NULL, expire = NULL, code = NULL WHERE oid = ?"
      ).bind(oid).run();
      return { success: true };
    }

    // ===== 业务分发 =====
    switch (action) {
      case 'getApiConfig': {
        const cfg = await getConfig('__api_config__') || {};
        return jsonResponse({
          success: true,
          apiUser: cfg.user || '',
          apiPass: cfg.pass || '',
          sid: cfg.sid || '24085',
          ascription: cfg.ascription || '',
          paragraph: cfg.paragraph || '',
          exclude: cfg.exclude || '',
          uid: cfg.uid || ''
        });
      }

      case 'saveApiConfig': {
        const newUser = url.searchParams.get('apiUser');
        const newPass = url.searchParams.get('apiPass');
        const newSid  = url.searchParams.get('sid');
        const newAscription = url.searchParams.get('ascription') || '';
        const newParagraph = url.searchParams.get('paragraph') || '';
        const newExclude = url.searchParams.get('exclude') || '';
        const newUid = url.searchParams.get('uid') || '';

        const existing = await getConfig('__api_config__') || {};

        let finalUser = existing.user || '';
        let finalPass = existing.pass || '';

        if (newUser && newPass) {
          finalUser = newUser;
          finalPass = newPass;
        } else if (newUser || newPass) {
          return jsonResponse({ error: '账号和密码必须同时提供' }, 400);
        } else {
          if (!finalUser || !finalPass) {
            return jsonResponse({ error: '首次配置需要提供账号和密码' }, 400);
          }
        }

        const newConfig = {
          user: finalUser,
          pass: finalPass,
          sid: newSid || existing.sid || '24085',
          ascription: newAscription,
          paragraph: newParagraph,
          exclude: newExclude,
          uid: newUid
        };

        await putConfig('__api_config__', newConfig);

        if (finalUser !== existing.user || finalPass !== existing.pass) {
          await deleteConfig('__token_data__');
        }

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
            const entry = await DB.prepare('SELECT * FROM phone_pool WHERE phone = ?').bind(phone).first();
            if (entry && entry.status === 'in_use') {
              if (entry.oid) {
                const order = await getOrder(entry.oid);
                if (order && order.status === 'active') {
                  await DB.batch([
                    DB.prepare("UPDATE orders SET status = 'released', phone = NULL, expire = NULL WHERE oid = ?").bind(entry.oid),
                    DB.prepare('DELETE FROM active_orders WHERE oid = ?').bind(entry.oid)
                  ]);
                }
              }
              await DB.prepare(
                "UPDATE phone_pool SET status = 'available', oid = NULL, expire = NULL WHERE phone = ?"
              ).bind(phone).run();
            }
            return jsonResponse({ success: true, msg: cancelData.msg || '释放成功' });
          }
          return jsonResponse({ success: false, error: cancelData.msg || '平台释放失败' }, 400);
        } catch (e) {
          return jsonResponse({ error: '请求接码平台失败: ' + e.message }, 500);
        }
      }

      case 'listActiveOrders': {
        const now = Date.now();
        await DB.prepare('DELETE FROM active_orders WHERE expire IS NOT NULL AND expire <= ?').bind(now).run();
        const { results } = await DB.prepare('SELECT oid, phone, expire FROM active_orders').all();
        return jsonResponse({ orders: results });
      }

      case 'listAllOrders': {
        const cursorStr = url.searchParams.get('cursor') || null;
        const limit = Math.min(parseInt(url.searchParams.get('limit')) || 100, 200);

        // 游标格式：`createdAt:oid`（复合游标，避免同一毫秒内翻页丢数据）
        let cursor = null;
        if (cursorStr) {
          const idx = cursorStr.indexOf(':');
          if (idx > 0) {
            const createdAt = Number(cursorStr.slice(0, idx));
            const cursorOid = cursorStr.slice(idx + 1);
            if (Number.isFinite(createdAt) && cursorOid) cursor = { createdAt, oid: cursorOid };
          }
        }

        let sql = `SELECT oid, phone, assigned_phone, status, code, expire, done_time, created_at, phone_assigned_at
                   FROM orders WHERE status = 'done'`;
        const params = [];
        if (cursor) {
          sql += ' AND (created_at < ? OR (created_at = ? AND oid < ?))';
          params.push(cursor.createdAt, cursor.createdAt, cursor.oid);
        }
        sql += ' ORDER BY created_at DESC, oid DESC LIMIT ?';
        params.push(limit);

        const { results } = await DB.prepare(sql).bind(...params).all();

        const orders = results.map(r => ({
          oid: r.oid,
          phone: r.phone || '---',
          assignedPhone: r.assigned_phone || '',
          status: r.status,
          code: r.code || '',
          expire: r.expire || null,
          doneTime: r.done_time || null,
          createdAt: r.created_at || null,
          phoneAssignedAt: r.phone_assigned_at || null
        }));

        const totalRow = await DB.prepare("SELECT COUNT(*) AS c FROM orders WHERE status = 'done'").first();

        const last = orders[orders.length - 1];
        const hasMore = orders.length === limit;
        const nextCursor = hasMore && last ? `${last.createdAt}:${last.oid}` : null;

        return jsonResponse({
          orders,
          cursor: nextCursor,
          list_complete: !hasMore,
          total: totalRow ? totalRow.c : 0
        });
      }

      case 'rebuildOrderIndex': {
        // D1 模式不再需要 JSON 索引，保留接口以兼容前端
        return jsonResponse({ success: true, total: 0, message: 'D1 模式无需重建索引' });
      }

      case 'releaseAllOrders': {
        const { results } = await DB.prepare('SELECT oid FROM active_orders').all();
        const details = [];
        for (const row of results) {
          const result = await releaseOrderByOid(row.oid);
          details.push({ oid: row.oid, success: result.success, error: result.error });
        }
        const successCount = details.filter(r => r.success).length;
        return jsonResponse({ success: true, released: successCount, total: details.length, details });
      }

      case 'createOrder': {
        if (!oid) return jsonResponse({ error: '缺少订单ID' }, 400);
        const existing = await getOrder(oid);
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

        await saveOrder(oid, newOrder);
        return jsonResponse({ success: true });
      }

      case 'generateCard': {
        const type = url.searchParams.get('type') || 'trial';
        const count = parseInt(url.searchParams.get('count')) || 1;
        if (count < 1 || count > 100) return jsonResponse({ error: '数量需在1-100之间' }, 400);
        const duration = type === 'month' ? 30 : 1;
        const generated = [];
        const stmts = [];
        const now = Date.now();
        for (let i = 0; i < count; i++) {
          const key = generateCardKey();
          stmts.push(
            DB.prepare('INSERT INTO cards (key, type, duration, activated, created_at) VALUES (?, ?, ?, 0, ?)')
              .bind(key, type, duration, now)
          );
          generated.push(key);
        }
        await DB.batch(stmts);
        return jsonResponse({ success: true, keys: generated });
      }

      case 'activateCard': {
        const key = url.searchParams.get('key');
        if (!key) return jsonResponse({ error: '缺少卡密' }, 400);
        const card = await DB.prepare('SELECT * FROM cards WHERE key = ?').bind(key).first();
        if (!card) return jsonResponse({ error: '卡密不存在' }, 404);
        if (card.activated) {
          if (Date.now() > card.expire_at) return jsonResponse({ error: '卡密已过期' }, 400);
          return jsonResponse({ success: true, expire_at: card.expire_at });
        }
        const now = Date.now();
        const expireAt = now + card.duration * 86400 * 1000;
        await DB.prepare('UPDATE cards SET activated = 1, activated_at = ?, expire_at = ? WHERE key = ?')
          .bind(now, expireAt, key).run();
        return jsonResponse({ success: true, expire_at: expireAt });
      }

      case 'verifyCard': {
        const key = url.searchParams.get('key');
        if (!key) return jsonResponse({ error: '缺少卡密' }, 400);
        const card = await DB.prepare('SELECT * FROM cards WHERE key = ?').bind(key).first();
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
        await DB.prepare('DELETE FROM cards WHERE key = ?').bind(key).run();
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
          await DB.prepare('DELETE FROM phone_pool WHERE phone = ?').bind(phone).run();
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
        const existing = await DB.prepare('SELECT phone FROM phone_pool WHERE phone = ?').bind(phone).first();
        if (existing) return jsonResponse({ error: '号码已存在' }, 400);
        await DB.prepare("INSERT INTO phone_pool (phone, status, oid, expire) VALUES (?, 'available', NULL, NULL)")
          .bind(phone).run();
        return jsonResponse({ success: true });
      }

      case 'removePhone': {
        const phone = url.searchParams.get('phone');
        if (!phone) return jsonResponse({ error: '缺少 phone 参数' }, 400);
        await DB.prepare('DELETE FROM phone_pool WHERE phone = ?').bind(phone).run();
        return jsonResponse({ success: true });
      }

      case 'resetPool': {
        const { results } = await DB.prepare("SELECT phone, oid FROM phone_pool WHERE status = 'in_use'").all();
        const stmts = [];
        for (const row of results) {
          if (row.oid) {
            const order = await getOrder(row.oid);
            if (order && order.status === 'active') {
              stmts.push(DB.prepare("UPDATE orders SET status = 'released', phone = NULL, expire = NULL WHERE oid = ?").bind(row.oid));
              stmts.push(DB.prepare('DELETE FROM active_orders WHERE oid = ?').bind(row.oid));
            }
          }
          stmts.push(DB.prepare("UPDATE phone_pool SET status = 'available', oid = NULL, expire = NULL WHERE phone = ?").bind(row.phone));
        }
        // 分批执行，避免单次 batch 语句过多
        for (let i = 0; i < stmts.length; i += 100) {
          await DB.batch(stmts.slice(i, i + 100));
        }
        return jsonResponse({ success: true });
      }

      case 'releasePoolPhone': {
        const phone = url.searchParams.get('phone');
        if (!phone) return jsonResponse({ error: '缺少 phone 参数' }, 400);
        const entry = await DB.prepare('SELECT * FROM phone_pool WHERE phone = ?').bind(phone).first();
        if (!entry) return jsonResponse({ error: '号码不在池中' }, 404);
        if (entry.status !== 'in_use') return jsonResponse({ error: '该号码未被占用' }, 400);
        const stmts = [];
        if (entry.oid) {
          const order = await getOrder(entry.oid);
          if (order && order.status === 'active') {
            stmts.push(DB.prepare("UPDATE orders SET status = 'released', phone = NULL, expire = NULL WHERE oid = ?").bind(entry.oid));
            stmts.push(DB.prepare('DELETE FROM active_orders WHERE oid = ?').bind(entry.oid));
          }
        }
        stmts.push(DB.prepare("UPDATE phone_pool SET status = 'available', oid = NULL, expire = NULL WHERE phone = ?").bind(phone));
        await DB.batch(stmts);
        return jsonResponse({ success: true });
      }

      case 'logList': {
        const { results } = await DB.prepare(
          'SELECT phone, oid, action, time FROM phone_logs ORDER BY id DESC LIMIT 100'
        ).all();
        return jsonResponse({ logs: results });
      }

      case 'status': {
        const order = await getOrder(oid);
        if (!order) return jsonResponse({ status: 'invalid', phone: null, expire: null, code: null });
        if (order.expire && order.status === 'active' && Date.now() >= order.expire) {
          await releaseOrderPhone(order, oid);
          await DB.prepare(
            "UPDATE orders SET status = 'expired', phone = NULL, expire = NULL WHERE oid = ?"
          ).bind(oid).run();
          return jsonResponse({ status: 'expired', phone: null, expire: null, code: null });
        }
        return jsonResponse(order);
      }

      case 'getPhone': {
        let order = await getOrder(oid);
        if (!order) return jsonResponse({ error: '订单不存在或已失效' }, 404);
        if (order.status === 'done') return jsonResponse({ error: '订单已完成' }, 403);
        if (order.status === 'released') return jsonResponse({ error: '订单已被管理员释放' }, 403);

        if (order.status === 'expired') {
          order.status = 'new'; order.phone = null; order.expire = null; order.code = null; order.fromPool = false;
          await saveOrder(oid, order);
        }

        if (order.status === 'active' && order.expire && Date.now() < order.expire) {
          return jsonResponse({ phone: order.phone, expire: order.expire });
        }

        if (order.status === 'active' && order.expire && Date.now() >= order.expire) {
          await releaseOrderPhone(order, oid);
          order.status = 'new'; order.phone = null; order.expire = null; order.code = null; order.fromPool = false;
          await saveOrder(oid, order);
        }

        if (order.phone && order.fromPool) {
          await DB.prepare(
            "UPDATE phone_pool SET status = 'available', oid = NULL, expire = NULL WHERE phone = ? AND status = 'in_use'"
          ).bind(order.phone).run();
        }

        const tokenStr = await getValidToken();
        const orderSid = order.sid || HAOZHU.sid;

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
            await saveOrder(oid, order);
            await updateActiveIndex(oid, realPhone, order.expire);
            return jsonResponse({ phone: realPhone, expire: order.expire });
          }
          return jsonResponse({ error: '获取指定手机号失败：' + (phoneData.msg || '平台无该号或已被占用') }, 400);
        }

        // 原子占用池中号码，避免并发下多个订单抢到同一号码
        const expire = Date.now() + PHONE_TTL_MS;
        const pickedRes = await DB.prepare(`
          UPDATE phone_pool SET status = 'in_use', oid = ?, expire = ?
          WHERE phone = (SELECT phone FROM phone_pool WHERE status = 'available' ORDER BY RANDOM() LIMIT 1)
          RETURNING phone
        `).bind(oid, expire).all();

        const picked = pickedRes.results && pickedRes.results[0];
        if (picked) {
          const phone = picked.phone;
          try {
            const activateUrl = `https://${HAOZHU.server}/sms/?api=getPhone&token=${tokenStr}&sid=${orderSid}&phone=${phone}`;
            await fetchWithTimeout(activateUrl);
          } catch (e) {}

          order.phone = phone;
          order.expire = expire;
          order.status = 'active';
          order.code = null;
          order.fromPool = true;
          order.phoneAssignedAt = Date.now();
          await saveOrder(oid, order);
          await updateActiveIndex(oid, phone, expire);
          return jsonResponse({ phone, expire });
        }

        // 池中无可用号码，走平台取号
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
          order.phone = phone;
          order.expire = Date.now() + PHONE_TTL_MS;
          order.status = 'active';
          order.code = null;
          order.fromPool = false;
          order.phoneAssignedAt = Date.now();
          await saveOrder(oid, order);
          await updateActiveIndex(oid, phone, order.expire);
          return jsonResponse({ phone, expire: order.expire });
        }
        return jsonResponse({ error: phoneData.msg || '取号失败' }, 500);
      }

      case 'release': {
        const order = await getOrder(oid);
        if (!order) return jsonResponse({ error: '订单不存在' }, 404);
        if (order.status === 'done') return jsonResponse({ error: '订单已完成' }, 403);

        await releaseOrderPhone(order, oid);

        await DB.prepare(
          "UPDATE orders SET status = 'new', phone = NULL, expire = NULL, code = NULL, from_pool = 0 WHERE oid = ?"
        ).bind(oid).run();
        return jsonResponse({ success: true });
      }

      case 'getSMS': {
        const order = await getOrder(oid);
        if (!order) return jsonResponse({ error: '订单不存在' }, 404);

        if (order.status === 'active' && order.expire && Date.now() >= order.expire) {
          await releaseOrderPhone(order, oid);
          await DB.prepare(
            "UPDATE orders SET status = 'expired', phone = NULL, expire = NULL WHERE oid = ?"
          ).bind(oid).run();
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
              await DB.batch([
                DB.prepare("UPDATE orders SET code = ?, status = 'done', done_time = ? WHERE oid = ?")
                  .bind(match[1], Date.now(), oid),
                DB.prepare('DELETE FROM active_orders WHERE oid = ?').bind(oid)
              ]);
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
        const order = {
          phone,
          expire: 0,
          status: 'pending',
          code: null,
          fromPool: false,
          createdAt: Date.now()
        };
        await saveOrder(oid, order);
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
