/**
 * The chat page and the login page. Plain HTML and a little script, no build
 * step: it has to work in a phone browser and be readable by someone who is
 * not a programmer.
 */
export const PAGE = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>我的助理</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.6 system-ui, -apple-system, "PingFang SC", sans-serif; height: 100dvh; display: flex; flex-direction: column; }
  header { padding: 12px 16px; border-bottom: 1px solid #8884; font-weight: 600; }
  #log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 44rem; padding: 10px 14px; border-radius: 14px; white-space: pre-wrap; word-break: break-word; }
  .me { align-self: flex-end; background: #2f7cf6; color: #fff; }
  .bot { align-self: flex-start; background: #8881; }
  .sys { align-self: center; font-size: 13px; opacity: .6; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; background: #8882; padding: 1px 4px; border-radius: 4px; }
  a { color: inherit; }
  form { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid #8884; }
  textarea { flex: 1; resize: none; font: inherit; padding: 10px; border-radius: 12px; border: 1px solid #8886; background: transparent; color: inherit; }
  button { font: inherit; padding: 0 18px; border-radius: 12px; border: 0; background: #2f7cf6; color: #fff; }
  button:disabled { opacity: .5; }
</style>
<header>我的助理</header>
<div id="log"></div>
<form id="form">
  <textarea id="text" rows="1" placeholder="说点什么，比如「十分钟后提醒我关火」"></textarea>
  <button id="send">发送</button>
</form>
<script>
  const log = document.getElementById('log');
  const form = document.getElementById('form');
  const text = document.getElementById('text');
  const send = document.getElementById('send');

  // Models write a little markdown whether or not anyone asked. Showing the
  // asterisks to a person who is not a programmer looks broken, so the three
  // bits that show up most are drawn as they were meant. Everything is built
  // from text nodes: nothing a model writes can become markup.
  const parts = /(\\*\\*[^*\\n]+\\*\\*|\`[^\`\\n]+\`|https?:\\/\\/[^\\s]+)/g;

  function render(target, body) {
    body.split(parts).forEach((piece) => {
      if (!piece) return;
      if (piece.startsWith('**') && piece.endsWith('**')) {
        const strong = document.createElement('strong');
        strong.textContent = piece.slice(2, -2);
        target.appendChild(strong);
      } else if (piece.startsWith('\`') && piece.endsWith('\`')) {
        const code = document.createElement('code');
        code.textContent = piece.slice(1, -1);
        target.appendChild(code);
      } else if (piece.startsWith('http')) {
        const link = document.createElement('a');
        link.href = piece;
        link.rel = 'noreferrer noopener';
        link.target = '_blank';
        link.textContent = piece;
        target.appendChild(link);
      } else {
        target.appendChild(document.createTextNode(piece));
      }
    });
  }

  function add(kind, body) {
    const div = document.createElement('div');
    div.className = 'msg ' + kind;
    render(div, body);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  add('sys', '直接说话就行。我是跑在这台机器上的，记性存在本地。');

  const events = new EventSource('/api/events');
  events.onmessage = (event) => {
    const data = JSON.parse(event.data);
    add(data.role === 'me' ? 'me' : 'bot', data.text);
  };
  events.onerror = () => add('sys', '连接断了，正在重试…');

  form.onsubmit = async (event) => {
    event.preventDefault();
    const body = text.value.trim();
    if (!body) return;
    text.value = '';
    text.style.height = 'auto';
    add('me', body);
    send.disabled = true;
    try {
      const reply = await fetch('/api/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: body }),
      });
      if (!reply.ok) add('sys', '没发出去：' + reply.status);
    } finally {
      send.disabled = false;
      text.focus();
    }
  };

  text.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  text.addEventListener('input', () => {
    text.style.height = 'auto';
    text.style.height = text.scrollHeight + 'px';
  });
</script>
</html>`;

/** Asked for only when WEB_PASSWORD is set: one field, then the chat page. */
export const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>进入助理</title>
<style>
  body { margin: 0; font: 16px/1.6 system-ui, -apple-system, "PingFang SC", sans-serif; height: 100dvh; display: grid; place-items: center; }
  form { display: flex; flex-direction: column; gap: 12px; width: min(20rem, 80vw); }
  input, button { font: inherit; padding: 10px 12px; border-radius: 12px; border: 1px solid #8886; background: transparent; color: inherit; }
  button { background: #2f7cf6; color: #fff; border: 0; }
  p { opacity: .7; font-size: 14px; margin: 0; }
</style>
<form id="form">
  <h1 style="font-size:20px;margin:0">进入助理</h1>
  <input id="password" type="password" placeholder="访问密码" autocomplete="current-password" autofocus>
  <button>进去</button>
  <p id="error"></p>
</form>
<script>
  const form = document.getElementById('form');
  const password = document.getElementById('password');
  const error = document.getElementById('error');
  form.onsubmit = async (event) => {
    event.preventDefault();
    error.textContent = '';
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
    });
    if (response.ok) location.reload();
    else error.textContent = '密码不对';
  };
</script>
</html>`;
