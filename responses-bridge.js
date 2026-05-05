const express = require('express');

const OBS = '[STAA_OBS]';

function obs(level, payload) {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
  fn(OBS, {
    __staaObs: true,
    protocol: 'staa-obs-v1',
    ...payload,
  });
}

function normalizeEndpoint(endpoint) {
  const base = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  if (base.endsWith('/v1/responses')) return base;
  if (base.endsWith('/responses')) return base;
  if (base.endsWith('/v1')) return `${base}/responses`;
  return `${base}/v1/responses`;
}

function parseExtraBody(input) {
  if (!input) return {};
  if (typeof input === 'object' && !Array.isArray(input)) return input;

  try {
    const parsed = JSON.parse(String(input));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // ignore
  }

  throw new Error('extraBody 不是有效 JSON 对象');
}

function normalizeRole(role) {
  const value = String(role || 'user').toLowerCase();
  if (value === 'assistant') return 'assistant';
  if (value === 'system') return 'system';
  return 'user';
}

function mapMessageContent(role, content) {
  const text = String(content ?? '');
  const type = role === 'assistant' ? 'output_text' : 'input_text';
  return [{ type, text }];
}

function messagesToResponsesInput(messages) {
  if (!Array.isArray(messages)) return [];

  return messages
    .filter(msg => msg && typeof msg.content === 'string')
    .map(msg => {
      const role = normalizeRole(msg.role);
      return {
        role,
        content: mapMessageContent(role, msg.content),
      };
    });
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

function parseJsonSafe(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function buildErrorMessage(response, text, json) {
  return json?.error?.message
    || json?.message
    || `Upstream HTTP ${response.status}: ${String(text || response.statusText || 'Unknown error').slice(0, 400)}`;
}

async function init(router) {
  router.use(express.json({ limit: '2mb' }));

  router.get('/health', async (_req, res) => {
    res.json({
      ok: true,
      plugin: 'responses-bridge',
    });
  });

  router.post('/generate', async (req, res) => {
    const endpoint = normalizeEndpoint(req.body?.endpoint);
    const apiKey = String(req.body?.apiKey || '').trim();
    const model = String(req.body?.model || '').trim();
    const timeoutMs = Number(req.body?.timeoutMs) || 120000;
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const extraBody = parseExtraBody(req.body?.extraBody);

    if (!endpoint) {
      return res.status(400).json({
        ok: false,
        message: 'endpoint 不能为空',
      });
    }

    if (!model) {
      return res.status(400).json({
        ok: false,
        message: 'model 不能为空',
      });
    }

    const input = messagesToResponsesInput(messages);

    if (!input.length) {
      return res.status(400).json({
        ok: false,
        message: 'messages 不能为空',
      });
    }

    const requestBody = {
      ...extraBody,
      model,
      input,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    obs('info', {
      level: 'info',
      module: 'ResponsesBridgePlugin',
      stage: 'request',
      action: 'generate',
      target: endpoint,
      code: 'RBP_REQ_START',
      status: 'start',
      message: 'Server Plugin 准备向上游 Responses API 发起请求',
      hint: '若失败，优先检查 endpoint、model、apiKey 和 extraBody',
      sourceFile: 'responses-bridge.js',
      data: {
        model,
        timeoutMs,
        inputCount: input.length,
      },
    });

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      const responseText = await response.text();
      const json = parseJsonSafe(responseText, null);

      if (!response.ok) {
        const message = buildErrorMessage(response, responseText, json);

        obs('error', {
          level: 'error',
          module: 'ResponsesBridgePlugin',
          stage: 'fail',
          action: 'generate',
          target: endpoint,
          code: 'RBP_UPSTREAM_HTTP_FAILED',
          status: 'failed',
          message: '上游 Responses API 返回非 2xx',
          hint: '优先检查上游是否真的支持 /v1/responses，以及请求体字段是否被兼容层接受',
          sourceFile: 'responses-bridge.js',
          data: {
            status: response.status,
            model,
            upstreamMessage: message,
          },
        });

        return res.status(502).json({
          ok: false,
          message,
        });
      }

      const text = extractOutputText(json).trim();

      if (!text) {
        obs('warn', {
          level: 'warn',
          module: 'ResponsesBridgePlugin',
          stage: 'parse',
          action: 'generate',
          target: endpoint,
          code: 'RBP_EMPTY_TEXT',
          status: 'failed',
          message: '上游返回成功，但未提取到文本',
          hint: '检查返回体是否不是 output_text / output[].content[].text 形态',
          sourceFile: 'responses-bridge.js',
          data: {
            model,
          },
        });

        return res.status(502).json({
          ok: false,
          message: '上游返回成功，但未提取到文本',
        });
      }

      obs('info', {
        level: 'info',
        module: 'ResponsesBridgePlugin',
        stage: 'done',
        action: 'generate',
        target: endpoint,
        code: 'RBP_REQ_OK',
        status: 'ok',
        message: 'Server Plugin 已成功完成 Responses 请求并提取文本',
        hint: '若前端没显示，检查 UI 扩展写回消息逻辑',
        sourceFile: 'responses-bridge.js',
        data: {
          model,
          chars: text.length,
        },
      });

      return res.json({
        ok: true,
        text,
      });
    } catch (error) {
      const isAbort = String(error?.name || '').toLowerCase() === 'aborterror';

      obs('error', {
        level: 'error',
        module: 'ResponsesBridgePlugin',
        stage: 'fail',
        action: 'generate',
        target: endpoint,
        code: isAbort ? 'RBP_TIMEOUT' : 'RBP_FETCH_FAILED',
        status: 'failed',
        message: isAbort ? 'Server Plugin 请求上游超时' : 'Server Plugin 请求上游失败',
        hint: '超时则提高 timeoutMs；否则检查网络、证书、上游地址和服务状态',
        sourceFile: 'responses-bridge.js',
        data: {
          model,
          error: String(error),
        },
      });

      return res.status(500).json({
        ok: false,
        message: isAbort ? '请求上游超时' : String(error?.message || error || 'Unknown error'),
      });
    } finally {
      clearTimeout(timer);
    }
  });

  obs('info', {
    level: 'info',
    module: 'ResponsesBridgePlugin',
    stage: 'init',
    action: 'init',
    target: '/api/plugins/responses-bridge/*',
    code: 'RBP_INIT_OK',
    status: 'ok',
    message: 'Responses Bridge Server Plugin 已加载',
    hint: '下一步重启 ST 后在前端点“检测插件”确认健康状态',
    sourceFile: 'responses-bridge.js',
    data: {},
  });

  return Promise.resolve();
}

async function exit() {
  obs('info', {
    level: 'info',
    module: 'ResponsesBridgePlugin',
    stage: 'done',
    action: 'exit',
    target: 'plugin',
    code: 'RBP_EXIT_OK',
    status: 'ok',
    message: 'Responses Bridge Server Plugin 已退出',
    hint: '如无特殊错误可忽略此日志',
    sourceFile: 'responses-bridge.js',
    data: {},
  });

  return Promise.resolve();
}

module.exports = {
  init,
  exit,
  info: {
    id: 'responses-bridge',
    name: 'Responses Bridge',
    description: 'Bridge chat interception to upstream /v1/responses via a local ST server plugin.',
  },
};