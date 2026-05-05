const MODULE_NAME = 'responses_bridge';
const OBS = '[STAA_OBS]';
const PLUGIN_ID = 'responses-bridge';
const PLUGIN_BASE = `/api/plugins/${PLUGIN_ID}`;
const PLUGIN_HEALTH_URL = `${PLUGIN_BASE}/health`;
const PLUGIN_GENERATE_URL = `${PLUGIN_BASE}/generate`;

window.__responsesBridgeState = {
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
    continue: false,
  },
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

function normalizeGenType(type) {
  return typeof type === 'string' && type.length ? type : 'normal';
}

function shouldIntercept(type, settings) {
  const genType = normalizeGenType(type);
  const map = settings.interceptTypes || {};
  return Boolean(map[genType]);
}

function escapeHtml(str) {
  return String(str || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function ensureStyles() {
  if (document.querySelector('#responses-bridge-style')) return;

  const style = document.createElement('style');
  style.id = 'responses-bridge-style';
  style.textContent = `
    :root {
      --rb-gap: 10px;
      --rb-label-width: 92px;
    }

    #rb-settings-root {
      width: 100%;
      max-width: 100%;
      box-sizing: border-box;
    }

    .rb-panel {
      display: flex;
      flex-direction: column;
      gap: var(--rb-gap);
      width: 100%;
      max-width: 100%;
      max-height: calc(100dvh - 180px);
      overflow: auto;
      overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      padding-bottom: env(safe-area-inset-bottom, 0);
      box-sizing: border-box;
    }

    .rb-row {
      display: grid;
      grid-template-columns: var(--rb-label-width) minmax(0, 1fr);
      gap: var(--rb-gap);
      align-items: center;
      width: 100%;
      box-sizing: border-box;
    }

    .rb-row-block {
      align-items: start;
    }

    .rb-label {
      text-align: right;
      white-space: nowrap;
    }

    .rb-input {
      width: 100%;
      min-width: 0;
      box-sizing: border-box;
    }

    .rb-input[type="text"],
    .rb-input[type="password"],
    .rb-input[type="number"],
    textarea.rb-input {
      min-height: 40px;
    }

    .rb-details {
      border: 1px solid var(--SmartThemeBorderColor, rgba(255,255,255,0.15));
      border-radius: 10px;
      padding: 8px 10px;
    }

    .rb-details > summary {
      cursor: pointer;
      user-select: none;
      list-style: none;
      font-weight: 600;
      outline: none;
    }

    .rb-details > summary::-webkit-details-marker {
      display: none;
    }

    .rb-details-body {
      margin-top: 10px;
      display: flex;
      flex-direction: column;
      gap: var(--rb-gap);
    }

    .rb-checks {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 12px;
    }

    .rb-checks label {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
    }

    .rb-actions {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--rb-gap);
    }

    #rb-settings-btn {
      margin-top: 8px;
      width: 100%;
    }

    @media (max-width: 640px) {
      .rb-row {
        grid-template-columns: 1fr;
      }

      .rb-label {
        text-align: left;
      }

      .rb-checks {
        grid-template-columns: 1fr;
      }

      .rb-actions {
        grid-template-columns: 1fr;
      }

      .rb-panel {
        max-height: calc(100dvh - 150px);
      }
    }
  `;
  document.head.appendChild(style);
}

function getPluginHeaders() {
  const ctx = getContextSafe();
  const headers = typeof ctx.getRequestHeaders === 'function' ? ctx.getRequestHeaders() : {};
  return {
    ...headers,
    'Content-Type': 'application/json',
  };
}

function getLastUserMessage(chat) {
  for (let i = chat.length - 1; i >= 0; i--) {
    const item = chat[i];
    if (item && item.is_user) return item;
  }
  return null;
}

function chatToPluginMessages(chat) {
  return chat
    .filter(item => item && typeof item.mes === 'string')
    .map(item => ({
      role: item.is_system ? 'system' : (item.is_user ? 'user' : 'assistant'),
      content: item.mes,
    }));
}

function parseExtraBodyOrThrow(text) {
  const source = String(text || '').trim();
  if (!source) return {};
  const parsed = parseJsonSafe(source, null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('extraBody 不是有效 JSON 对象');
  }
  return parsed;
}

async function checkPluginHealth() {
  const response = await fetch(PLUGIN_HEALTH_URL, {
    method: 'GET',
    headers: getPluginHeaders(),
    credentials: 'same-origin',
    cache: 'no-cache',
  });

  if (!response.ok) {
    return false;
  }

  const json = await response.json().catch(() => null);
  return Boolean(json?.ok);
}

async function callPluginGenerate(chat, settings) {
  const endpoint = String(settings.endpoint || '').trim();
  const model = String(settings.model || '').trim();
  const apiKey = String(settings.apiKey || '').trim();

  if (!endpoint) {
    throw new Error('Endpoint 不能为空');
  }
  if (!model) {
    throw new Error('Model 不能为空');
  }

  const extraBody = parseExtraBodyOrThrow(settings.extraBody);
  const payload = {
    endpoint,
    apiKey,
    model,
    timeoutMs: Number(settings.timeoutMs) || 120000,
    messages: chatToPluginMessages(chat),
    extraBody,
  };

  obs('info', {
    level: 'info',
    module: 'ResponsesBridge',
    stage: 'request',
    action: 'callPluginGenerate',
    target: PLUGIN_GENERATE_URL,
    code: 'RB_PLUGIN_REQ_START',
    status: 'start',
    message: '准备调用本地 Server Plugin 生成 Responses 请求',
    hint: '如果失败，优先检查 plugin 文件是否已复制到 plugins 目录，以及 config.yaml 是否开启 enableServerPlugins',
    sourceFile: 'index.js',
    data: {
      endpoint,
      model,
      messageCount: payload.messages.length,
    },
  });

  const response = await fetch(PLUGIN_GENERATE_URL, {
    method: 'POST',
    headers: getPluginHeaders(),
    credentials: 'same-origin',
    cache: 'no-cache',
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  const json = parseJsonSafe(text, null);

  if (response.status === 404) {
    throw new Error('未检测到 Responses Bridge Server Plugin，或 enableServerPlugins 未开启');
  }

  if (!response.ok) {
    throw new Error(json?.message || json?.error || `HTTP ${response.status}: ${text}`);
  }

  if (!json?.ok) {
    throw new Error(json?.message || 'Server Plugin 返回失败');
  }

  obs('info', {
    level: 'info',
    module: 'ResponsesBridge',
    stage: 'parse',
    action: 'callPluginGenerate',
    target: PLUGIN_GENERATE_URL,
    code: 'RB_PLUGIN_REQ_OK',
    status: 'ok',
    message: 'Server Plugin 请求成功并已完成解析',
    hint: '若文本为空，检查上游 Responses 返回是否包含 output_text 或 output[].content[].text',
    sourceFile: 'index.js',
    data: {
      chars: String(json.text || '').length,
    },
  });

  return json;
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

  if (typeof ctx.updateMessageBlock === 'function') {
    try {
      ctx.updateMessageBlock(ctx.chat.length - 1, message);
    } catch {
      // 签名差异不阻塞主流程
    }
  }

  if (typeof ctx.eventSource?.emit === 'function' && ctx.eventTypes?.MESSAGE_RECEIVED) {
    await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, message);
  }

  if (typeof ctx.eventSource?.emit === 'function' && ctx.eventTypes?.GENERATION_ENDED) {
    await ctx.eventSource.emit(ctx.eventTypes.GENERATION_ENDED);
  }

  if (typeof ctx.scrollChatToBottom === 'function') {
    try {
      ctx.scrollChatToBottom();
    } catch {
      // 忽略滚动失败
    }
  }
}

async function handleIntercept(type) {
  const settings = getSettings();
  window.__responsesBridgeState.enabled = settings.enabled;

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
      module: 'ResponsesBridge',
      stage: 'read',
      action: 'handleIntercept',
      target: 'chat',
      code: 'RB_NO_USER_MSG',
      status: 'failed',
      message: '未找到最后一条有效用户消息，已跳过拦截',
      hint: '检查当前聊天是否真的有用户输入',
      sourceFile: 'index.js',
      data: {
        type: normalizeGenType(type),
      },
    });
    return false;
  }

  window.__responsesBridgeState.lastInterceptedAt = Date.now();
  window.__responsesBridgeState.lastStatus = 'running';
  window.__responsesBridgeState.lastError = null;

  obs('info', {
    level: 'info',
    module: 'ResponsesBridge',
    stage: 'entry',
    action: 'interceptGeneration',
    target: 'generate_interceptor',
    code: 'RB_INTERCEPT_START',
    status: 'start',
    message: '已拦截原生生成，准备改走本地 Server Plugin',
    hint: '如果失败，先看是否正确安装了 Server Plugin',
    sourceFile: 'index.js',
    data: {
      type: normalizeGenType(type),
    },
  });

  try {
    const result = await callPluginGenerate(liveChat, settings);
    const replyText = String(result.text || '').trim();

    if (!replyText) {
      throw new Error('Server Plugin 返回了空文本');
    }

    await appendAssistantMessage(replyText);

    window.__responsesBridgeState.lastStatus = 'ok';

    obs('info', {
      level: 'info',
      module: 'ResponsesBridge',
      stage: 'render',
      action: 'appendAssistantMessage',
      target: 'chat',
      code: 'RB_RENDER_OK',
      status: 'ok',
      message: '已将 Responses 返回文本写回聊天',
      hint: '如果界面没刷新，先切换聊天再切回来确认',
      sourceFile: 'index.js',
      data: {
        chars: replyText.length,
      },
    });

    return true;
  } catch (error) {
    window.__responsesBridgeState.lastStatus = 'failed';
    window.__responsesBridgeState.lastError = String(error);

    obs('error', {
      level: 'error',
      module: 'ResponsesBridge',
      stage: 'fail',
      action: 'handleIntercept',
      target: 'chat',
      code: 'RB_INTERCEPT_FAILED',
      status: 'failed',
      message: '拦截已触发，但 Server Plugin 生成或写回失败',
      hint: '优先查看 [STAA_OBS] 日志；若提示找不到 plugin，检查 plugins 目录和 config.yaml',
      sourceFile: 'index.js',
      data: {
        error: String(error),
      },
    });

    throw error;
  }
}

function buildSettingsDom() {
  const ctx = getContextSafe();
  const settings = getSettings();

  const root = document.createElement('div');
  root.id = 'rb-settings-root';
  root.innerHTML = `
    <div class="rb-panel">
      <div class="rb-row">
        <label class="rb-label" for="rb-enabled">启用拦截</label>
        <input class="rb-input" id="rb-enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>
      </div>

      <div class="rb-row">
        <label class="rb-label" for="rb-endpoint">Endpoint</label>
        <input class="rb-input" id="rb-endpoint" type="text" inputmode="url" autocomplete="off" placeholder="https://your-host/v1 或 /v1/responses" value="${escapeHtml(settings.endpoint)}">
      </div>

      <div class="rb-row">
        <label class="rb-label" for="rb-api-key">API Key</label>
        <input class="rb-input" id="rb-api-key" type="password" autocomplete="off" placeholder="sk-..." value="${escapeHtml(settings.apiKey)}">
      </div>

      <div class="rb-row">
        <label class="rb-label" for="rb-model">Model</label>
        <input class="rb-input" id="rb-model" type="text" autocomplete="off" placeholder="gpt-5.5" value="${escapeHtml(settings.model)}">
      </div>

      <div class="rb-row">
        <label class="rb-label" for="rb-timeout-ms">超时(ms)</label>
        <input class="rb-input" id="rb-timeout-ms" type="number" min="1000" step="1000" value="${Number(settings.timeoutMs) || 120000}">
      </div>

      <details class="rb-details">
        <summary>高级参数</summary>
        <div class="rb-details-body">
          <div class="rb-row rb-row-block">
            <label class="rb-label" for="rb-extra-body">extraBody(JSON)</label>
            <textarea class="rb-input" id="rb-extra-body" rows="4" placeholder='{"reasoning":{"effort":"high"}}'>${escapeHtml(settings.extraBody)}</textarea>
          </div>

          <div class="rb-row rb-row-block">
            <div class="rb-label">拦截类型</div>
            <div class="rb-checks">
              <label><input type="checkbox" data-rb-type="normal" ${settings.interceptTypes.normal ? 'checked' : ''}> normal</label>
              <label><input type="checkbox" data-rb-type="regenerate" ${settings.interceptTypes.regenerate ? 'checked' : ''}> regenerate</label>
              <label><input type="checkbox" data-rb-type="swipe" ${settings.interceptTypes.swipe ? 'checked' : ''}> swipe</label>
              <label><input type="checkbox" data-rb-type="quiet" ${settings.interceptTypes.quiet ? 'checked' : ''}> quiet</label>
              <label><input type="checkbox" data-rb-type="impersonate" ${settings.interceptTypes.impersonate ? 'checked' : ''}> impersonate</label>
              <label><input type="checkbox" data-rb-type="continue" ${settings.interceptTypes.continue ? 'checked' : ''}> continue</label>
            </div>
          </div>
        </div>
      </details>

      <div class="rb-actions">
        <button id="rb-save-btn" class="menu_button">保存</button>
        <button id="rb-check-btn" class="menu_button">检测插件</button>
        <button id="rb-test-btn" class="menu_button">测试请求</button>
      </div>
    </div>
  `;

  const enabledEl = root.querySelector('#rb-enabled');
  const endpointEl = root.querySelector('#rb-endpoint');
  const apiKeyEl = root.querySelector('#rb-api-key');
  const modelEl = root.querySelector('#rb-model');
  const timeoutEl = root.querySelector('#rb-timeout-ms');
  const extraBodyEl = root.querySelector('#rb-extra-body');
  const saveBtn = root.querySelector('#rb-save-btn');
  const checkBtn = root.querySelector('#rb-check-btn');
  const testBtn = root.querySelector('#rb-test-btn');

  function readDraftSettings() {
    const next = getSettings();
    next.enabled = Boolean(enabledEl.checked);
    next.endpoint = String(endpointEl.value || '').trim();
    next.apiKey = String(apiKeyEl.value || '').trim();
    next.model = String(modelEl.value || '').trim();
    next.timeoutMs = Number(timeoutEl.value) || 120000;
    next.extraBody = String(extraBodyEl.value || '{}').trim() || '{}';

    for (const el of root.querySelectorAll('[data-rb-type]')) {
      const key = el.getAttribute('data-rb-type');
      next.interceptTypes[key] = Boolean(el.checked);
    }

    return next;
  }

  saveBtn.addEventListener('click', () => {
    const next = readDraftSettings();
    try {
      parseExtraBodyOrThrow(next.extraBody);
    } catch (error) {
      toastr.error(error.message || String(error));
      return;
    }

    ctx.saveSettingsDebounced();
    window.__responsesBridgeState.enabled = next.enabled;
    toastr.success('Responses Bridge 设置已保存');
  });

  checkBtn.addEventListener('click', async () => {
    const loaderHandle = ctx.loader.show({
      blocking: false,
      message: 'Checking Responses Bridge Server Plugin...',
      toastMode: 'static',
    });

    try {
      const ok = await checkPluginHealth();
      if (ok) {
        toastr.success('Server Plugin 已就绪');
      } else {
        toastr.error('未检测到 Server Plugin，或 enableServerPlugins 未开启');
      }
    } catch (error) {
      toastr.error(`检测失败：${error.message || error}`);
    } finally {
      await loaderHandle.hide();
    }
  });

  testBtn.addEventListener('click', async () => {
    const draft = readDraftSettings();

    const loaderHandle = ctx.loader.show({
      blocking: false,
      message: 'Testing Responses Bridge...',
      toastMode: 'static',
    });

    try {
      const ok = await checkPluginHealth();
      if (!ok) {
        throw new Error('未检测到 Server Plugin，或 enableServerPlugins 未开启');
      }

      const result = await callPluginGenerate(
        [
          {
            is_user: true,
            mes: '请只回复：测试成功',
          },
        ],
        draft
      );

      toastr.success(`测试成功：${String(result.text || '').slice(0, 80)}`);
    } catch (error) {
      toastr.error(`测试失败：${error.message || error}`);
    } finally {
      await loaderHandle.hide();
    }
  });

  return root;
}

function ensureSettingsButton() {
  if (document.querySelector('#rb-settings-btn')) return;

  ensureStyles();

  const btn = document.createElement('button');
  btn.id = 'rb-settings-btn';
  btn.className = 'menu_button';
  btn.textContent = 'Responses Bridge';

  btn.addEventListener('click', async () => {
    const ctx = getContextSafe();
    const popup = new ctx.Popup(
      buildSettingsDom(),
      ctx.POPUP_TYPE.TEXT,
      'Responses Bridge',
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

globalThis.responsesBridgeGenerateInterceptor = async function(chat, contextSize, abort, type) {
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
  } catch (error) {
    toastr.error(`Responses Bridge 失败：${error.message || error}`);
  }
};

export async function onActivate() {
  const ctx = getContextSafe();
  getSettings();
  ensureStyles();
  ensureSettingsButton();

  ctx.eventSource.on(ctx.eventTypes.APP_READY, () => {
    ensureStyles();
    ensureSettingsButton();
  });

  obs('info', {
    level: 'info',
    module: 'ResponsesBridge',
    stage: 'init',
    action: 'activate',
    target: 'extension',
    code: 'RB_ACTIVATE_OK',
    status: 'ok',
    message: 'Responses Bridge UI 扩展已激活',
    hint: '下一步复制 server-plugin/responses-bridge.js 到 ST 的 plugins 目录，开启 enableServerPlugins 并重启',
    sourceFile: 'index.js',
    data: {},
  });
}