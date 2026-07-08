// Static permission page loaded in a normal popup window. Unlike the side
// panel, a top-level extension window shows a reliable getUserMedia prompt,
// and the grant persists to the extension origin (so the side-panel mic works
// afterwards). No inline script — the page CSP is `script-src 'self'`.

const btn = document.getElementById('allow');
const status = document.getElementById('status');

const setStatus = (text, kind) => {
  status.textContent = text;
  status.className = kind || '';
};

const requestPermission = async () => {
  btn.disabled = true;
  setStatus('Waiting for your response…');
  try {
    // Requesting the stream is what surfaces the browser prompt. We only need
    // the grant, so stop the tracks immediately to release the mic.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    setStatus('Microphone enabled. You can close this window.', 'ok');
    // Give the user a moment to read, then close automatically.
    setTimeout(() => window.close(), 1200);
  } catch (err) {
    btn.disabled = false;
    const name = err && err.name ? err.name : 'Error';
    if (name === 'NotAllowedError') {
      setStatus('Permission was blocked. Click again and choose Allow.', 'err');
    } else if (name === 'NotFoundError') {
      setStatus('No microphone was found on this device.', 'err');
    } else {
      setStatus('Could not access the microphone: ' + name, 'err');
    }
  }
};

btn.addEventListener('click', requestPermission);
