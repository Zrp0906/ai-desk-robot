const stage = document.querySelector('#stage');
const status = document.querySelector('#status');
const feedback = document.querySelector('#feedback');
const record = document.querySelector('#record');
const replay = document.querySelector('#replay');
const reset = document.querySelector('#reset');
const textForm = document.querySelector('#text-form');
const text = document.querySelector('#text');
const send = textForm.querySelector('button');
const transcript = document.querySelector('#transcript');
const locateForm = document.querySelector('#locate-form');
const target = document.querySelector('#target');
const photoInput = document.querySelector('#photo');
const takePhoto = locateForm.querySelector('button');
const cameraToggle = document.querySelector('#camera-toggle');
const cameraPreview = document.querySelector('#camera-preview');

const canRecord = navigator.mediaDevices?.getUserMedia && window.MediaRecorder;
const speaker = window.speechSynthesis;
const playback = new Audio();
const history = [];
let phase = 'ready';
let recording;
let macSpeech;
let cameraStream;

function setPhase(next, label) {
  phase = next;
  stage.dataset.state = next;
  status.textContent = label;
  const ready = next === 'ready';
  const listening = next === 'recording';
  record.textContent = listening ? '说完了' : '开始说话';
  record.setAttribute('aria-pressed', listening);
  record.disabled = !canRecord || !(ready || listening);
  text.disabled = send.disabled = !ready;
  target.disabled = takePhoto.disabled = !ready;
  cameraToggle.disabled = !navigator.mediaDevices?.getUserMedia || !ready;
  reset.disabled = !ready || !history.length;
  replay.disabled = !ready || !history.length;
}

function finish(message = '') {
  feedback.textContent = message;
  setPhase('ready', '准备就绪');
}

async function request(path, type, body, format = 'json') {
  let response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': type },
      body,
    });
  } catch (_) {
    throw new Error('无法连接贾维斯，请检查 Mac 上的服务和 USB 连接。');
  }
  if (response.ok && format === 'audio' && response.headers.get('Content-Type') === 'audio/wav') {
    return response.blob();
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data || format !== 'json') throw new Error(data?.error || '服务暂时不可用。');
  return data;
}

function showTurn(role, content) {
  const item = document.createElement('li');
  const label = document.createElement('strong');
  label.textContent = role === 'user' ? '你' : '贾维斯';
  item.append(label, document.createTextNode(content));
  transcript.append(item);
  transcript.scrollTop = transcript.scrollHeight;
}

function clearMacSpeech() {
  if (!macSpeech) return;
  playback.removeAttribute('src');
  URL.revokeObjectURL(macSpeech.url);
  macSpeech = null;
}

async function speakFromMac(reply) {
  try {
    if (macSpeech?.reply !== reply) {
      const audio = await request('/api/speak', 'application/json', JSON.stringify({ text: reply }), 'audio');
      clearMacSpeech();
      macSpeech = { reply, url: URL.createObjectURL(audio) };
      playback.src = macSpeech.url;
    }
    await playback.play();
  } catch (error) {
    finish(error.name === 'NotAllowedError' ? '点「重播回答」开始播放。' : error.message);
  }
}

playback.onplaying = () => setPhase('speaking', '贾维斯在说话');
playback.onended = () => finish();
playback.onerror = () => {
  clearMacSpeech();
  finish('音频播放失败，可以点「重播回答」。');
};

function speak(reply) {
  setPhase('working', '正在准备播报');
  const voices = speaker?.getVoices().filter((voice) => voice.localService && /^(zh|cmn)([-_]|$)/i.test(voice.lang));
  const voice = voices?.find((item) => /[-_](cn|hans)([-_]|$)/i.test(item.lang)) || voices?.[0];
  if (!voice) {
    speakFromMac(reply);
    return;
  }

  const utterance = new SpeechSynthesisUtterance(reply);
  utterance.lang = voice.lang;
  utterance.voice = voice;
  utterance.onstart = () => setPhase('speaking', '贾维斯在说话');
  utterance.onend = () => finish();
  utterance.onerror = () => {
    setPhase('working', '正在准备播报');
    speakFromMac(reply);
  };
  speaker.speak(utterance);
}

function replyTo(content, reply) {
  history.push({ role: 'user', content }, { role: 'assistant', content: reply });
  showTurn('user', content);
  showTurn('assistant', reply);
  speak(reply);
}

function searchTarget(content) {
  const command = content.trim()
    .replace(/^[贾賈][维維]斯[，,、\s]*/, '')
    .replace(/[。！!？?]+$/, '').trim();
  const match = command.match(/^(?:请|請)?(?:(?:帮|幫)我)?(?:找(?:一下|一找)?|寻找|尋找)\s*(.{1,80}?)\s*(?:吧|好吗|好嗎)?$/)
    || command.match(/^(.{1,80}?)(?:在哪里|在哪裡|在哪裏|在哪儿|在哪兒|在哪)$/);
  if (!match) return null;
  const item = match[1].trim();
  if (!item || /^(?:不|一下$|一找$)|[，。！？,.!?]|怎么|怎麼|如何|为什么|為什麼/.test(item)) return null;
  return /^(?:纸巾|紙巾|抽纸|抽紙|餐巾纸|餐巾紙)$/.test(item) ? '纸巾' : item;
}

async function identifyPhoto(item, image, content) {
  setPhase('working', '正在识别照片');
  const body = JSON.stringify({ target: item, image });
  const { reply } = await request('/api/locate', 'application/json', body);
  replyTo(content, reply);
}

async function sendMessage(content) {
  feedback.textContent = '';
  try {
    const item = searchTarget(content);
    if (item) {
      target.value = item;
      if (!cameraStream) {
        replyTo(content, '请先点「开启相机」，让镜头对准桌面，再让我找。');
      } else {
        setPhase('working', '正在拍摄当前画面');
        const image = await captureCamera();
        await identifyPhoto(item, image, content);
      }
    } else {
      setPhase('working', '贾维斯在想');
      const messages = [...history.slice(-8), { role: 'user', content }];
      const { reply } = await request('/api/chat', 'application/json', JSON.stringify({ messages }));
      replyTo(content, reply);
    }
    if (text.value.trim() === content) text.value = '';
  } catch (error) {
    if (!text.value) text.value = content;
    finish(error.message || '请求失败，请重试。');
  }
}

function encodePhoto(source, width, height) {
  const scale = Math.min(1, 1024 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d', { alpha: false }).drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85).split(',', 2)[1];
}

async function resizePhoto(file) {
  const photo = await createImageBitmap(file).catch(() => {
    throw new Error('打不开这张照片，请重新拍摄。');
  });
  try {
    return encodePhoto(photo, photo.width, photo.height);
  } finally {
    photo.close();
  }
}

function closeCamera(message = '') {
  if (cameraStream) for (const track of cameraStream.getTracks()) track.stop();
  cameraStream = null;
  cameraPreview.pause();
  cameraPreview.srcObject = null;
  cameraPreview.hidden = true;
  cameraToggle.textContent = '开启相机';
  cameraToggle.setAttribute('aria-pressed', 'false');
  if (message) feedback.textContent = message;
}

async function openCamera() {
  feedback.textContent = '';
  setPhase('working', '正在打开相机');
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    const track = cameraStream.getVideoTracks()[0];
    track.addEventListener('ended', () => closeCamera('相机已中断，请重新开启。'), { once: true });
    cameraPreview.srcObject = cameraStream;
    cameraPreview.hidden = false;
    await cameraPreview.play();
    cameraToggle.textContent = '关闭相机';
    cameraToggle.setAttribute('aria-pressed', 'true');
    finish();
  } catch (error) {
    closeCamera();
    finish(error.name === 'NotAllowedError'
      ? '请在浏览器的站点设置里允许相机权限。'
      : '无法打开相机，请检查是否被其他应用占用后重试。');
  }
}

async function captureCamera() {
  if (document.visibilityState !== 'visible' || cameraStream?.getVideoTracks()[0]?.readyState !== 'live') {
    throw new Error('相机未就绪，请保持页面在前台并重新开启相机。');
  }
  if (cameraPreview.requestVideoFrameCallback) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cameraPreview.cancelVideoFrameCallback(callback);
        reject(new Error('没有收到新的相机画面，请关闭相机后重新开启。'));
      }, 2500);
      const callback = cameraPreview.requestVideoFrameCallback(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (cameraPreview.readyState < 2 || !cameraPreview.videoWidth || cameraPreview.paused) {
    throw new Error('相机画面尚未就绪，请重新开启相机后再试。');
  }
  return encodePhoto(cameraPreview, cameraPreview.videoWidth, cameraPreview.videoHeight);
}

function stopRecording() {
  setPhase('working', '正在转写语音');
  recording.stop();
}

async function startRecording() {
  feedback.textContent = '';
  setPhase('working', '正在打开麦克风');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    const started = performance.now();
    const limit = setTimeout(stopRecording, 20_000);
    let failed = false;

    function releaseMic() {
      clearTimeout(limit);
      for (const track of stream.getTracks()) track.stop();
      recording = null;
    }

    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.onerror = () => {
      failed = true;
      releaseMic();
      finish('录音中断，请再试一次。');
    };
    recorder.onstop = async () => {
      if (failed) return;
      releaseMic();
      const audio = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type });
      if (!audio.size || performance.now() - started < 300) {
        finish('录音太短，请说完一句话再点「说完了」。');
        return;
      }
      try {
        const { text: content } = await request('/api/transcribe', audio.type, audio);
        await sendMessage(content);
      } catch (error) {
        finish(error.message || '录音上传失败，请重试。');
      }
    };

    try {
      recorder.start();
    } catch (error) {
      releaseMic();
      throw error;
    }
    recording = recorder;
    setPhase('recording', '正在听');
  } catch (error) {
    if (stream) for (const track of stream.getTracks()) track.stop();
    const message = error.name === 'NotAllowedError'
      ? '请在浏览器的站点设置里允许麦克风权限。'
      : '无法打开麦克风，请检查设备，也可以先输入文字。';
    finish(message);
  }
}

record.addEventListener('click', () => {
  if (phase === 'recording') stopRecording();
  else if (phase === 'ready') startRecording();
});

textForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const content = text.value.trim();
  if (phase === 'ready' && content) sendMessage(content);
});

cameraToggle.addEventListener('click', () => {
  if (phase !== 'ready') return;
  if (cameraStream) closeCamera();
  else openCamera();
});

window.addEventListener('pagehide', () => closeCamera());

locateForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (phase === 'ready' && target.value.trim()) photoInput.click();
});

photoInput.addEventListener('change', async () => {
  const file = photoInput.files[0];
  photoInput.value = '';
  const item = target.value.trim();
  if (!file || !item || phase !== 'ready') return;

  feedback.textContent = '';
  setPhase('working', '正在识别照片');
  try {
    const image = await resizePhoto(file);
    await identifyPhoto(item, image, `拍照找${item}`);
  } catch (error) {
    finish(error.message || '找物请求失败，请重新拍摄。');
  }
});

replay.addEventListener('click', () => {
  feedback.textContent = '';
  speak(history[history.length - 1].content);
});

reset.addEventListener('click', () => {
  history.length = 0;
  text.value = '';
  transcript.replaceChildren();
  clearMacSpeech();
  finish();
});

finish(canRecord ? '' : '浏览器无法录音。请通过本机地址打开页面，或先输入文字。');
