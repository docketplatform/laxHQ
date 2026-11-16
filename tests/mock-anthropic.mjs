// A tiny stand-in for the Anthropic Messages API, used by the function and browser tests.
// The functions emulator is pointed at it through ANTHROPIC_BASE_URL (see tests/setup-env.mjs).
import http from 'node:http';

export const MOCK_PORT = 4599;

/** Start the mock. `reply(body)` returns { stop_reason?, json? | text? }. Returns { requests, close, setReply }. */
export function startMockAnthropic(reply = () => ({ json: { subject: 'Class of 2029 Midfield · Test', body: 'Coach,\n\nHello.\n\nJake' } })) {
  const requests = [];
  let handler = reply;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (!req.url.startsWith('/v1/messages')) { res.writeHead(404).end(); return; }
      const body = JSON.parse(raw || '{}');
      requests.push({ url: req.url, headers: req.headers, body });
      const r = handler(body) || {};
      const text = r.text ?? JSON.stringify(r.json ?? {});
      res.writeHead(r.status || 200, { 'Content-Type': 'application/json', 'request-id': 'req_mock' });
      res.end(JSON.stringify(r.status && r.status >= 400 ? { type: 'error', error: { type: 'rate_limit_error', message: 'busy' } } : {
        id: `msg_mock_${requests.length}`, type: 'message', role: 'assistant', model: body.model,
        content: r.stop_reason === 'refusal' ? [] : [{ type: 'text', text }],
        stop_reason: r.stop_reason || 'end_turn', stop_sequence: null, stop_details: null,
        usage: { input_tokens: 500, output_tokens: 200 },
      }));
    });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve({
    requests, setReply: (fn) => { handler = fn; }, close: () => new Promise((r) => server.close(r)),
  })));
}
