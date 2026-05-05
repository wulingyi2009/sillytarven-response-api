const MODULE_NAME = 'rhrsp_bridge';
const OBS = '[STAA_OBS]';

window.__rhrsp_extState = {
  enabled: false,
  lastInterceptedAt: 0,
  lastStatus: 'idle',
  lastError: null,
};

const defaultSettings = Object.freeze({
  enabled: false,
  endpoint: '',
  apiKey: '',
  model: '',
  timeoutMs: 120000,
  extraBody: '{}',
  interceptTypes: {
    normal: true,
    regenerate: true,
    swipe: false,
    quiet: false,
    impersonate: false,
    continue: false
  }
});

function obs(level, payload) {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
  fn(OBS, {
    __staaObs: true,
    protocol: 'staa-obs-v1',
    ...payload,
  });
}

function getContextSafe() {
  return SillyTavern.getContext();
}

function getSettings() {
  const { extensionSettings } = getContextSafe();
  if (!extensionSettings[MODULE_NAME]) {
    extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
  }
  const current = extensionSettings[MODULE_NAME];
  if (typeof current.interceptTypes !== 'object' || !current.interceptTypes) {
    current.interceptTypes = structuredClone(defaultSettings.interceptTypes);
  }
  for (const [key, value] of Object.entries(defaultSettings)) {
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      current[key] = structuredClone(value);
    }
  }
  return current;
}

function parseJsonSafe(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function normalizeEndpoint(endpoint) {
  const base = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (base.endsWith('/v1/responses')) return base;
  if (base.endsWith('/v1')) return `${base}/responses`;
  return `${base}/v1/responses`;
}

function shouldIntercept(type, settings) {
  const map = settings.interceptTypes || {};
  return Boolean(map[type]);
}

function getLastUserMessage(chat) {
  for (let i = chat.length - 1; i >= 0; i--) {
    const item = chat[i];
    if (item && item.is_user) return item;
  }
  return null;
}

function chatToResponsesInput(chat) {
  return chat
    .filter(x => x && typeof x.mes === 'string')
    .map(x => ({
      role: x.is_user ? 'user' : 'assistant',
      content: [
        {
          type: 'input_text',
          text: x.mes,
        },
      ],
    }));
}

function extractOutputText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text;
  }

  if (Array.isArray(data?.output)) {
    const chunks = [];

    for (const item of data.output) {
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === 'string' && part.text) {
            chunks.push(part.text);
          }
        }
      }
    }

    const merged = chunks.join('\n').trim();
    if (merged) return merged;
  }

  if (typeof data?.content === 'string' && data.content.trim()) {
    return data.content;
  }

  return '';
}

async function callResponsesApi(chat, settings) {
  const endpoint = normalizeEndpoint(settings.endpoint);
  if (!endpoint) {
    throw new Error('Responses endpoint is empty');
  }

  const extraBody = parseJsonSafe(settings.extraBody, {});
  const body = {
    model: settings.model,
    input: chatToResponsesInput(chat),
    ...extraBody,
  };

  const controller = new AbortController();
  const timeoutMs = Number(settings.timeoutMs) || 120000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    obs('info', {
      level: 'info',
      module: 'RikkaHubResponsesBridge',
      stage: 'request',
      action: 'callResponsesApi',
      target: endpoint,
      code: 'RHRSP_REQ_START',
      status: 'start',
      message: '准备向 Responses API 发送请求',
      hint: '检查 endpoint、model、apiKey 和 extraBody 是否正确',
      sourceFile: 'index.js',
      data: {
        model: settings.model,
        timeoutMs,
        inputCount: body.input.length,
      },
    });

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.apiKey ? { 'Authorization': `Bearer ${settings.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    const data = parseJsonSafe(text, null);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    obs('info', {
      level: 'info',
      module: 'RikkaHubResponsesBridge',
      stage: 'parse',
      action: 'callResponsesApi',
      target: endpoint,
      code: 'RHRSP_REQ_OK',
      status: 'ok',
      message: 'Responses API 请求成功并已完成解析',
      hint: '如果回复为空，检查返回体是否含 output_text 或 output.content',
      sourceFile: 'index.js',
      data: {
        status: response.status,
      },
    });

    return data;
  } catch (error) {
    obs('error', {
      level: 'error',
      module: 'RikkaHubResponsesBridge',
      stage: 'fail',
      action: 'callResponsesApi',
      target: endpoint,
      code: 'RHRSP_REQ_FAILED',
      status: 'failed',
      message: 'Responses API 请求失败',
      hint: '优先检查 endpoint 是否应为 /v1 或 /v1/responses、上游是否接受当前 body 结构',
      sourceFile: 'index.js',
      data: {
        error: String(error),
        model: settings.model,
      },
    });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function appendAssistantMessage(text) {
  const ctx = getContextSafe();

  const message = {
    name: ctx.name2 || 'Assistant',
    is_user: false,
    is_system: false,
    mes: text,
    send_date: Date.now(),
    extra: {},
  };

  if (typeof ctx.addOneMessage === 'function') {
    ctx.addOneMessage(message);
  } else {
    ctx.chat.push(message);
  }

  if (typeof ctx.saveChat === 'function') {
    await ctx.saveChat();
  }

  if (typeof ctx.eventSource?.emit === 'function' && ctx.eventTypes?.MESSAGE_RECEIVED) {
    await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, message);
  }

  if (typeof ctx.eventSource?.emit === 'function' && ctx.eventTypes?.GENERATION_ENDED) {
    await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED);
  }

  if (typeof ctx.updateMessageBlock === 'function') {
    try {
      ctx.updateMessageBlock(ctx.chat.length - 1, message);
    } catch {
      // 某些版本这里可能签名不同，忽略，不阻塞主流程
    }
  }
}

async function handleIntercept(type) {
  const settings = getSettings();
  window.__rhrsp_extState.enabled = settings.enabled;

  if (!settings.enabled) {
    return false;
  }

  if (!shouldIntercept(type, settings)) {
    return false;
  }

  const ctx = getContextSafe();
  const liveChat = Array.isArray(ctx.chat) ? structuredClone(ctx.chat) : [];
  const lastUser = getLastUserMessage(liveChat);

  if (!lastUser?.mes?.trim()) {
    obs('warn', {
      level: 'warn',
      module: 'RikkaHubResponsesBridge',
      stage: 'read',
      action: 'handleIntercept',
      target: 'chat',
      code: 'RHRSP_NO_USER_MSG',
      status: 'failed',
      message: '未找到可发送的最后一条用户消息，已跳过拦截',
      hint: '检查当前聊天是否真的有用户输入',
      sourceFile: 'index.js',
      data: { type },
    });
    return false;
  }

  window.__rhrsp_extState.lastInterceptedAt = Date.now();
  window.__rhrsp_extState.lastStatus = 'running';
  window.__rhrsp_extState.lastError = null;

  obs('info', {
    level: 'info',
    module: 'RikkaHubResponsesBridge',
    stage: 'entry',
    action: 'interceptGeneration',
    target: 'generate_interceptor',
    code: 'RHRSP_INTERCEPT_START',
    status: 'start',
    message: '已拦截原生生成，准备改走 Responses API',
    hint: '若后续失败，先检查扩展设置中的 endpoint 和 model',
    sourceFile: 'index.js',
    data: { type },
  });

  try {
    const data = await callResponsesApi(liveChat, settings);
    const text = extractOutputText(data).trim();

    if (!text) {
      throw new Error('Responses API returned empty text');
    }

    await appendAssistantMessage(text);

    window.__rhrsp_extState.lastStatus = 'ok';

    obs('info', {
      level: 'info',
      module: 'RikkaHubResponsesBridge',
      stage: 'done',
      action: 'interceptGeneration',
      target: 'chat',
      code: 'RHRSP_DONE',
      status: 'ok',
      message: '已将 Responses 返回内容写回聊天',
      hint: '如界面未刷新，尝试手动切换聊天或刷新页面确认',
      sourceFile: 'index.js',
      data: {
        chars: text.length,
      },
    });

    return true;
  } catch (error) {
    window.__rhrsp_extState.lastStatus = 'failed';
    window.__rhrsp_extState.lastError = String(error);

    toastr.error(`RikkaHub Responses 失败：${error.message || error}`);

    obs('error', {
      level: 'error',
      module: 'RikkaHubResponsesBridge',
      stage: 'fail',
      action: 'interceptGeneration',
      target: 'chat',
      code: 'RHRSP_INTERCEPT_FAILED',
      status: 'failed',
      message: '拦截成功，但 Responses 生成或写回失败',
      hint: '检查浏览器控制台 [STAA_OBS] 日志，重点看 endpoint、返回体和文本抽取',
      sourceFile: 'index.js',
      data: {
        error: String(error),
      },
    });

    throw error;
  }
}

function renderSettings() {
  const ctx = getContextSafe();
  const settings = getSettings();

  const root = document.createElement('div');
  root.id = 'rhrsp-settings-root';
  root.innerHTML = `
    <div class="rhrsp-panel">
      <div class="rhrsp-row">
        <label class="rhrsp-label" for="rhrsp-enabled">启用拦截</label>
        <input class="rhrsp-input" id="rhrsp-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>
      </div>

      <div class="rhrsp-row">
        <label class="rhrsp-label" for="rhrsp-endpoint">Endpoint</label>
        <input class="rhrsp-input" id="rhrsp-endpoint" type="text" placeholder="https://your-host/v1 或 /v1/responses" value="${escapeHtml(settings.endpoint)}">
      </div>

      <div class="rhrsp-row">
        <label class="rhrsp-label" for="rhrsp-api-key">API Key</label>
        <input class="rhrsp-input" id="rhrsp-api-key" type="password" placeholder="sk-..." value="${escapeHtml(settings.apiKey)}">
      </div>

      <div class="rhrsp-row">
        <label class="rhrsp-label" for="rhrsp-model">Model</label>
        <input class="rhrsp-input" id="rhrsp-model" type="text" placeholder="gpt-5.5" value="${escapeHtml(settings.model)}">
      </div>

      <div class="rhrsp-row">
        <label class="rhrsp-label" for="rhrsp-timeout-ms">超时(ms)</label>
        <input class="rhrsp-input" id="rhrsp-timeout-ms" type="number" min="1000" step="1000" value="${Number(settings.timeoutMs) || 120000}">
      </div>

      <div class="rhrsp-row rhrsp-row-block">
        <label class="rhrsp-label" for="rhrsp-extra-body">extraBody(JSON)</label>
        <textarea class="rhrsp-input" id="rhrsp-extra-body" rows="8" placeholder='{"reasoning":{"effort":"high"}}'>${escapeHtml(settings.extraBody)}</textarea>
      </div>

      <div class="rhrsp-row rhrsp-row-block">
        <div class="rhrsp-label">拦截类型</div>
        <div class="rhrsp-checks">
          <label><input type="checkbox" data-rhrsp-type="normal" ${settings.interceptTypes.normal ? 'checked' : ''}> normal</label>
          <label><input type="checkbox" data-rhrsp-type="regenerate" ${settings.interceptTypes.regenerate ? 'checked' : ''}> regenerate</label>
          <label><input type="checkbox" data-rhrsp-type="swipe" ${settings.interceptTypes.swipe ? 'checked' : ''}> swipe</label>
          <label><input type="checkbox" data-rhrsp-type="quiet" ${settings.interceptTypes.quiet ? 'checked' : ''}> quiet</label>
          <label><input type="checkbox" data-rhrsp-type="impersonate" ${settings.interceptTypes.impersonate ? 'checked' : ''}> impersonate</label>
          <label><input type="checkbox" data-rhrsp-type="continue" ${settings.interceptTypes.continue ? 'checked' : ''}> continue</label>
        </div>
      </div>

      <div class="rhrsp-actions">
        <button id="rhrsp-save-btn" class="menu_button">保存</button>
        <button id="rhrsp-test-btn" class="menu_button">测试请求</button>
      </div>
    </div>
  `;

  const enabledEl = root.querySelector('#rhrsp-enabled');
  const endpointEl = root.querySelector('#rhrsp-endpoint');
  const apiKeyEl = root.querySelector('#rhrsp-api-key');
  const modelEl = root.querySelector('#rhrsp-model');
  const timeoutEl = root.querySelector('#rhrsp-timeout-ms');
  const extraBodyEl = root.querySelector('#rhrsp-extra-body');
  const saveBtn = root.querySelector('#rhrsp-save-btn');
  const testBtn = root.querySelector('#rhrsp-test-btn');

  saveBtn.addEventListener('click', () => {
    const next = getSettings();
    next.enabled = Boolean(enabledEl.checked);
    next.endpoint = String(endpointEl.value || '').trim();
    next.apiKey = String(apiKeyEl.value || '').trim();
    next.model = String(modelEl.value || '').trim();
    next.timeoutMs = Number(timeoutEl.value) || 120000;
    next.extraBody = String(extraBodyEl.value || '{}').trim() || '{}';

    for (const el of root.querySelectorAll('[data-rhrsp-type]')) {
      const key = el.getAttribute('data-rhrsp-type');
      next.interceptTypes[key] = Boolean(el.checked);
    }

    ctx.saveSettingsDebounced();
    window.__rhrsp_extState.enabled = next.enabled;
    toastr.success('RikkaHub Responses 设置已保存');
  });

  testBtn.addEventListener('click', async () => {
    const tempSettings = {
      ...getSettings(),
      enabled: Boolean(enabledEl.checked),
      endpoint: String(endpointEl.value || '').trim(),
      apiKey: String(apiKeyEl.value || '').trim(),
      model: String(modelEl.value || '').trim(),
      timeoutMs: Number(timeoutEl.value) || 120000,
      extraBody: String(extraBodyEl.value || '{}').trim() || '{}',
    };

    const loaderHandle = ctx.loader.show({
      blocking: false,
      message: 'Testing RikkaHub Responses...',
      toastMode: 'static',
    });

    try {
      const data = await callResponsesApi(
        [
          {
            is_user: true,
            mes: '请回复：测试成功',
          },
        ],
        tempSettings
      );
      const text = extractOutputText(data);
      toastr.success(`测试成功：${(text || '').slice(0, 60)}`);
    } catch (error) {
      toastr.error(`测试失败：${error.message || error}`);
    } finally {
      await loaderHandle.hide();
    }
  });

  return root;
}

function escapeHtml(str) {
  return String(str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function ensureSettingsButton() {
  if (document.querySelector('#rhrsp-settings-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'rhrsp-settings-btn';
  btn.className = 'menu_button';
  btn.textContent = 'RikkaHub Responses';

  btn.addEventListener('click', async () => {
    const ctx = getContextSafe();
    const popup = new ctx.Popup(
      renderSettings(),
      ctx.POPUP_TYPE.TEXT,
      'RikkaHub Responses Bridge',
      {
        wide: true,
        okButton: '关闭',
        allowVerticalScrolling: true,
      }
    );
    await popup.show();
  });

  const host =
    document.querySelector('#extensions_settings2') ||
    document.querySelector('#extensions_settings') ||
    document.querySelector('#extensionsMenu') ||
    document.body;

  host.appendChild(btn);
}

globalThis.rhrspGenerateInterceptor = async function(chat, contextSize, abort, type) {
  const settings = getSettings();

  if (!settings.enabled) {
    return;
  }

  if (!shouldIntercept(type, settings)) {
    return;
  }

  abort(true);

  try {
    await handleIntercept(type);
  } catch {
    // 已在 handleIntercept 内部做日志与 toast
  }
};

export async function onActivate() {
  const ctx = getContextSafe();
  getSettings();
  ensureSettingsButton();

  ctx.eventSource.on(ctx.eventTypes.APP_READY, () => {
    ensureSettingsButton();
  });

  obs('info', {
    level: 'info',
    module: 'RikkaHubResponsesBridge',
    stage: 'init',
    action: 'activate',
    target: 'extension',
    code: 'RHRSP_ACTIVATE_OK',
    status: 'ok',
    message: 'RikkaHub Responses Bridge 已激活',
    hint: '下一步打开扩展按钮填写 endpoint、apiKey、model 并点测试请求',
    sourceFile: 'index.js',
    data: {},
  });
}