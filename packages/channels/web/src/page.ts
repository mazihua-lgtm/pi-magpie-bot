/**
 * The chat page and the login page. Plain HTML and a little script, no build
 * step: it has to work in a phone browser and be readable by someone who is
 * not a programmer.
 */
export const PAGE = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#2f7cf6">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon-192.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="喜鹊">
<meta name="mobile-web-app-capable" content="yes">
<title>喜鹊</title>
<style>
  /* One place for the brand blue and the surfaces. #1d63d8 is the same hue as
     the app icon but dark enough that white text on it passes 4.5:1; #2f7cf6
     does not (3.94:1). */
  :root {
    color-scheme: light dark;
    --brand: #1d63d8;
    --surface: #ffffff;
    --surface-2: #f1f2f4;
    --text: #1a1a1a;
    --muted: #5f6368;
    --border: #c4c7cc;
  }
  @media (prefers-color-scheme: dark) {
    :root { --surface: #121212; --surface-2: #26282b; --text: #f2f2f2; --muted: #b0b3b8; --border: #5c6066; }
  }
  body { margin: 0; font: 16px/1.6 system-ui, -apple-system, "PingFang SC", sans-serif; height: 100dvh; display: flex; flex-direction: column; background: var(--surface); color: var(--text); }
  header { padding: 12px 16px; padding-top: max(12px, env(safe-area-inset-top)); border-bottom: 1px solid var(--border); font-weight: 600; display: flex; align-items: center; gap: 12px; }
  header .title { flex: 1; }
  header button { font-size: 13px; font-weight: 500; padding: 7px 12px; }
  .pair-backdrop { position: fixed; inset: 0; background: #000a; display: grid; place-items: center; z-index: 10; padding: 20px; }
  .pair-card { background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 16px; padding: 24px; display: flex; flex-direction: column; align-items: center; gap: 12px; width: min(22rem, 90vw); text-align: center; }
  .pair-card img { width: 220px; height: 220px; image-rendering: pixelated; }
  .pair-code { font-size: 26px; font-weight: 700; letter-spacing: .18em; }
  .pair-note { font-size: 13px; opacity: .7; }
  #log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; }
  .msg { max-width: 44rem; padding: 10px 14px; border-radius: 16px; white-space: pre-wrap; word-break: break-word; }
  .me { align-self: flex-end; background: var(--brand); color: #fff; }
  /* A filled bubble, not a 6% tint: on a white page the tint came out at 1.07:1
     and the reply read as bare text with a rounded edge. */
  .bot { align-self: flex-start; background: var(--surface-2); }
  .bot.pending { color: var(--muted); font-style: italic; }
  .msg.failed { border: 1px solid #c62828; }
  .sys { align-self: center; font-size: 14px; color: var(--muted); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; background: var(--surface-2); padding: 1px 4px; border-radius: 6px; }
  a { color: inherit; }
  form { display: flex; gap: 8px; padding: 12px 16px; padding-bottom: max(12px, env(safe-area-inset-bottom)); padding-left: max(16px, env(safe-area-inset-left)); padding-right: max(16px, env(safe-area-inset-right)); border-top: 1px solid var(--border); }
  textarea { flex: 1; resize: none; font: inherit; padding: 10px; max-height: 30vh; border-radius: 12px; border: 1px solid var(--border); background: transparent; color: inherit; }
  .chips { align-self: flex-start; display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { padding: 11px 16px; min-height: 44px; border-radius: 999px; background: transparent; color: inherit; border: 1px solid var(--border); }
  button { font: inherit; padding: 0 18px; border-radius: 12px; border: 0; background: var(--brand); color: #fff; }
  button:disabled { opacity: .5; }
</style>
<header><span class="title">喜鹊</span><button type="button" id="pair-btn">配对手机</button></header>
<div id="log" role="log" aria-live="polite" aria-label="对话"></div>
<form id="form">
  <textarea id="text" rows="1" aria-label="给助理发消息" enterkeyhint="send"
    placeholder="说点什么，比如「十分钟后提醒我关火」"></textarea>
  <button id="send" type="submit">发送</button>
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

  /** Draws one message and gives it back, so a caller can undo or mark it. */
  function add(kind, body) {
    const div = document.createElement('div');
    div.className = 'msg ' + kind;
    render(div, body);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  // The same page runs in the app on a phone and in a browser on a computer;
  // "this machine" reads like a manual in neither place.
  const here = /\bwv\b/.test(navigator.userAgent) ? '这台手机' : '这台电脑';
  add('sys', '直接说话就行。我是跑在' + here + '上的，记性存在本地。');

  // A first visit gets things to try, so nobody faces an empty box. They
  // go away for good after the first message, from here or from the box.
  const tries = ['十分钟后提醒我关火', '记住：我对花生过敏', '我让你记过什么？'];
  let chips = null;
  try {
    if (!localStorage.getItem('talked')) {
      chips = document.createElement('div');
      chips.className = 'chips';
      tries.forEach((line) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.textContent = line;
        chip.onclick = () => submit(line);
        chips.appendChild(chip);
      });
      log.appendChild(chips);
    }
  } catch (error) {}

  // Only so a phone offers "add to home screen"; nothing is cached.
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  // A phone user can put this on the home screen and then it opens full screen,
  // with an icon, like an app. Said once: after that it is just noise. Android's
  // WebView also reports "not standalone", but it has no menu to add anything
  // from, so inside our own app the hint is simply wrong.
  const inApp = /\bwv\b/.test(navigator.userAgent) || /\bapp\.pimagpie\.bot\b/.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  try {
    if (!standalone && !inApp && !localStorage.getItem('hint')) {
      localStorage.setItem('hint', '1');
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
      add('sys', ios ? '想更像 App：点下面的分享按钮，选「添加到主屏幕」。' : '想更像 App：点右上角菜单，选「添加到主屏幕」。');
    }
  } catch (error) {}

  // The server replays recent history on every (re)connect, so a reconnecting
  // phone would draw the whole conversation again. Keep what is already on
  // screen and skip anything seen before.
  const seen = new Set();
  const key = (who, text) => who + '\u0000' + text;

  let offline = null;
  const events = new EventSource('/api/events');
  events.onopen = () => {
    if (offline) {
      offline.remove();
      offline = null;
    }
  };
  events.onmessage = (event) => {
    const data = JSON.parse(event.data);
    const who = data.role === 'me' ? 'me' : 'bot';
    const k = key(who, data.text);
    // The server replays recent history on every connect, so the same line can
    // arrive again after a reconnect. Draw it once.
    if (seen.has(k)) return;
    seen.add(k);
    think();
    add(who, data.text);
  };
  // One banner, not one line per failed retry: EventSource retries on its own
  // and can fire this many times a minute on a flaky phone connection.
  events.onerror = () => {
    if (offline) return;
    offline = document.createElement('div');
    offline.className = 'sys';
    offline.textContent = '连接断了，正在重试…';
    log.appendChild(offline);
  };

  /** A placeholder while the model thinks, so silence is not mistaken for a loss. */
  let pending = null;
  function think() {
    if (pending) {
      pending.remove();
      pending = null;
    }
  }
  function thinking() {
    think();
    pending = document.createElement('div');
    pending.className = 'bot pending';
    pending.textContent = '正在想…';
    log.appendChild(pending);
    log.scrollTop = log.scrollHeight;
  }

  async function submit(body) {
    if (chips) {
      chips.remove();
      chips = null;
    }
    try { localStorage.setItem('talked', '1'); } catch (error) {}
    const mine = add('me', body);
    send.disabled = true;
    thinking();
    try {
      const reply = await fetch('/api/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: body }),
      });
      if (!reply.ok) throw new Error('status ' + reply.status);
      seen.add(key('me', body));
    } catch (error) {
      // The text must not disappear: put it back where the user can resend it,
      // mark the bubble, and say what happened without an HTTP status code.
      think();
      if (mine) mine.classList.add('failed');
      text.value = body;
      add('sys', '没能发出去，检查一下网络再点发送。');
    } finally {
      send.disabled = false;
      text.focus();
    }
  }

  form.onsubmit = (event) => {
    event.preventDefault();
    const body = text.value.trim();
    if (!body) return;
    text.value = '';
    text.style.height = 'auto';
    submit(body);
  };

  text.addEventListener('keydown', (event) => {
    // A Chinese input method uses Enter to accept a candidate. Without this
    // check, confirming a word sends half of it.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  text.addEventListener('input', () => {
    text.style.height = 'auto';
    text.style.height = text.scrollHeight + 'px';
  });

  // Pair a phone: the QR carries a one-time code, never the password. The
  // phone swaps the code for its own signed session; the code dies on first use.
  const pairBtn = document.getElementById('pair-btn');
  pairBtn.addEventListener('click', async () => {
    pairBtn.disabled = true;
    pairBtn.textContent = '生成中…';
    try {
      const response = await fetch('/api/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '配对失败');
      const back = document.createElement('div');
      back.className = 'pair-backdrop';
      const card = document.createElement('div');
      card.className = 'pair-card';
      const img = document.createElement('img');
      img.alt = '配对二维码';
      img.src = '/api/pair/qr?code=' + encodeURIComponent(data.code) + '&t=' + Date.now();
      const code = document.createElement('div');
      code.className = 'pair-code';
      code.textContent = data.code;
      const note = document.createElement('p');
      note.className = 'pair-note';
      note.textContent = '用喜鹊 App 扫一扫，或手输这个码。' + data.address + ' · 5 分钟内有效，用一次即失效。';
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = '关闭';
      close.onclick = () => back.remove();
      card.append(img, code, note, close);
      back.appendChild(card);
      back.onclick = (e) => { if (e.target === back) back.remove(); };
      document.body.appendChild(back);
    } catch (error) {
      pairBtn.textContent = error.message || '配对失败';
      setTimeout(() => { pairBtn.textContent = '配对手机'; }, 2500);
    } finally {
      pairBtn.disabled = false;
    }
  });
</script>
</html>`;

/** Asked for only when WEB_PASSWORD is set: one field, then the chat page. */
export const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#2f7cf6">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon-192.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="喜鹊">
<meta name="mobile-web-app-capable" content="yes">
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
