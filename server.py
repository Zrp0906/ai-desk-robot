import base64
import io
import json
import os
import socket
import subprocess
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Lock
from urllib.error import URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/style.css": ("style.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
}
PORT = 8781
OLLAMA_MODEL = os.environ.get("JARVIS_CHAT_MODEL", "qwen2.5:1.5b")
VISION_MODEL = os.environ.get("JARVIS_VISION_MODEL", "qwen3-vl:2b")
ASR_MODEL = os.environ.get("JARVIS_ASR_MODEL", "base")
TTS_VOICE = os.environ.get("JARVIS_TTS_VOICE", "Tingting")
os.environ.setdefault("HF_HOME", str(ROOT / "runtime" / "huggingface"))

SYSTEM_PROMPT = (
    "你是贾维斯，一位中文语音助手。"
    "请根据前面的对话回答用户最新的问题。用简短、自然的简体中文回答。"
)
POSITION_LABELS = {"left": "左侧", "middle": "中间", "right": "右侧", "absent": ""}
PRESENCE_SCHEMA = {
    "type": "object",
    "properties": {"visible": {"type": "boolean"}},
    "required": ["visible"],
    "additionalProperties": False,
}
BOX_SCHEMA = {
    "type": "object",
    "properties": {"bbox_2d": {
        "type": "array", "items": {"type": "integer", "minimum": 0, "maximum": 1000}, "maxItems": 4,
    }},
    "required": ["bbox_2d"],
    "additionalProperties": False,
}
POST_LIMITS = {"/api/transcribe": 4_000_000, "/api/chat": 32_000, "/api/speak": 32_000, "/api/locate": 2_000_000}
asr_lock = Lock()
asr = None


def transcribe(audio):
    global asr
    from faster_whisper import WhisperModel

    with asr_lock:
        if asr is None:
            asr = WhisperModel(ASR_MODEL, device="cpu", compute_type="int8", cpu_threads=4)
        segments, _ = asr.transcribe(
            io.BytesIO(audio), language="zh", beam_size=3, vad_filter=True,
            condition_on_previous_text=False, initial_prompt="贾维斯，帮我找一下纸巾。纸巾在哪里？",
        )
        return "".join(segment.text for segment in segments).strip()


def ask_ollama(model, messages, num_predict, **params):
    request = Request(
        "http://127.0.0.1:11434/api/chat",
        data=json.dumps({
            "model": model,
            "messages": messages,
            "stream": False,
            "think": False,
            "options": {"num_ctx": 4096, "num_predict": num_predict, "temperature": 0},
            **params,
        }).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urlopen(request, timeout=65) as response:
        reply = json.load(response)["message"]["content"].strip()
    if not reply:
        raise ValueError("Empty model reply")
    return reply


def chat(messages):
    return ask_ollama(OLLAMA_MODEL, [{"role": "system", "content": SYSTEM_PROMPT}, *messages], 256)


def ask_about_photo(prompt, image, schema):
    messages = [{"role": "user", "content": prompt, "images": [image]}]
    return json.loads(ask_ollama(VISION_MODEL, messages, 768, format=schema))


def locate(target, image):
    if target == "纸巾":
        presence_prompt = (
            "Does the photo clearly show a facial tissue or a recognizable pack of facial tissues? "
            "A loose soft white tissue or a tissue visibly drawn out of a dispenser is strong evidence. "
            "Glare, scraps at the frame border, tags, and flat paper are background. "
            'Return {"visible":false} if unsure or absent, {"visible":true} only if clear.'
        )
        object_name = "pack of tissues or loose tissues"
    else:
        presence_prompt = f'照片中是否能清楚辨认出「{target}」？只返回 {{"visible":true}} 或 {{"visible":false}}。'
        object_name = target

    visible = ask_about_photo(presence_prompt, image, PRESENCE_SCHEMA)["visible"]
    if not isinstance(visible, bool):
        raise ValueError("Invalid vision presence result")
    if not visible:
        return "absent"

    box_prompt = (
        f"Locate the {object_name} in this photo. "
        'Output {"bbox_2d":[x_min,y_min,x_max,y_max]} on a 0-1000 scale, or {"bbox_2d":[]} if none is visible.'
    )
    box = ask_about_photo(box_prompt, image, BOX_SCHEMA)["bbox_2d"]
    if box == []:
        return "absent"
    if (not isinstance(box, list) or len(box) != 4
            or any(type(value) is not int or not 0 <= value <= 1000 for value in box)):
        raise ValueError("Invalid vision bounding box")
    left, top, right, bottom = box
    if left >= right or top >= bottom:
        raise ValueError("Empty vision bounding box")
    center = (left + right) / 2
    if center < 1000 / 3:
        return "left"
    if center < 2000 / 3:
        return "middle"
    return "right"


def read_location(body):
    payload = json.loads(body)
    target, image = payload["target"], payload["image"]
    if not isinstance(target, str) or not 0 < len(target.strip()) <= 80 or not isinstance(image, str):
        raise ValueError("Invalid location request")
    if not base64.b64decode(image, validate=True).startswith(b"\xff\xd8\xff"):
        raise ValueError("Expected a JPEG photo")
    return target.strip(), image


def synthesize_speech(text):
    with TemporaryDirectory(prefix="jarvis-tts-") as directory:
        audio_path = Path(directory) / "reply.wav"
        subprocess.run(
            ["/usr/bin/say", "-v", TTS_VOICE, "-o", str(audio_path),
             "--file-format=WAVE", "--data-format=LEI16@22050", "-f", "-"],
            input=text, encoding="utf-8", capture_output=True, check=True, timeout=15,
        )
        with wave.open(str(audio_path), "rb") as audio:
            if not audio.getnframes():
                raise ValueError("macOS speech synthesis returned no samples")
        return audio_path.read_bytes()


def read_messages(body):
    messages = json.loads(body)["messages"]
    if not isinstance(messages, list) or len(messages) not in (1, 3, 5, 7, 9):
        raise ValueError("Invalid conversation length")
    for index, entry in enumerate(messages):
        role = "assistant" if index % 2 else "user"
        if (entry["role"] != role or not isinstance(entry["content"], str)
                or not 0 < len(entry["content"].strip()) <= 1000):
            raise ValueError("Invalid message")
    return [{"role": entry["role"], "content": entry["content"]} for entry in messages]


class Handler(BaseHTTPRequestHandler):
    def handle_one_request(self):
        self.connection.settimeout(15)
        # A browser can open a connection before it has a request to send.
        try:
            self.rfile.peek(1)
        except socket.timeout:
            self.close_connection = True
            return
        super().handle_one_request()

    def respond(self, status, content_type, body):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; media-src 'self' blob:; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def json_response(self, status, **data):
        self.respond(status, "application/json; charset=utf-8", json.dumps(data, ensure_ascii=False).encode())

    def local_host(self):
        return self.headers.get("Host") in {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}

    def do_GET(self):
        asset = ASSETS.get(self.path) if self.local_host() else None
        if not asset:
            self.send_error(404)
            return
        filename, content_type = asset
        self.respond(200, content_type, (ROOT / "web" / filename).read_bytes())

    def do_POST(self):
        limit = POST_LIMITS.get(self.path)
        if not self.local_host() or limit is None:
            self.send_error(404)
            return
        audio = self.path == "/api/transcribe"
        content_type = self.headers.get_content_type()
        if (audio and not content_type.startswith("audio/")) or (not audio and content_type != "application/json"):
            self.json_response(415, error="音频或请求格式不支持。")
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= limit:
                raise ValueError("Invalid request size")
            body = self.rfile.read(size)
            if len(body) != size:
                raise ValueError("Incomplete request body")
        except socket.timeout:
            self.log_error("Timed out reading upload for %s", self.path)
            self.json_response(408, error="上传超时，请检查连接后重试。")
            return
        except (OSError, ValueError):
            self.json_response(400, error="请求为空、过大，或数据未传完。")
            return

        if audio:
            try:
                text = transcribe(body)
            except Exception as error:
                self.log_error("Transcription failed (%s): %s", type(error).__name__, error)
                self.json_response(503, error="语音转写失败，请检查 Mac 终端里的模型或音频错误。")
                return
            if not text:
                self.json_response(422, error="没有听清，再说一次。")
                return
            self.json_response(200, text=text)
            return

        if self.path == "/api/speak":
            self.speak(body)
            return
        if self.path == "/api/locate":
            self.locate(body)
            return

        try:
            messages = read_messages(body)
        except (ValueError, KeyError, TypeError):
            self.json_response(400, error="对话内容或长度无效。")
            return
        try:
            reply = chat(messages)
        except (URLError, OSError, ValueError, KeyError, TypeError) as error:
            self.log_error("Ollama failed (%s): %s", type(error).__name__, error)
            self.json_response(503, error=f"模型 {OLLAMA_MODEL} 暂时无法回答，请检查 Mac 上的 Ollama。")
            return
        self.json_response(200, reply=reply)

    def locate(self, body):
        try:
            target, image = read_location(body)
        except (ValueError, KeyError, TypeError):
            self.json_response(400, error="请输入物品名并提供有效的 JPEG 照片。")
            return
        try:
            position = locate(target, image)
        except (URLError, OSError, ValueError, KeyError, TypeError) as error:
            self.log_error("Vision model failed (%s): %s", type(error).__name__, error)
            self.json_response(503, error=f"视觉模型 {VISION_MODEL} 暂时无法判断，请检查 Mac 上的 Ollama 或重新拍照。")
            return
        reply = (f"这张照片里没找到{target}。" if position == "absent"
                 else f"{target}在画面{POSITION_LABELS[position]}。")
        self.json_response(200, position=position, reply=reply)

    def speak(self, body):
        try:
            text = json.loads(body)["text"]
            if not isinstance(text, str) or not 0 < len(text.strip()) <= 1000:
                raise ValueError("Invalid speech text")
        except (ValueError, KeyError, TypeError):
            self.json_response(400, error="播报文字为空或太长。")
            return
        try:
            audio = synthesize_speech(text.strip())
        except (subprocess.SubprocessError, OSError, EOFError, ValueError, wave.Error) as error:
            detail = getattr(error, "stderr", None) or str(error)
            self.log_error("macOS speech synthesis failed: %s", detail.strip())
            self.json_response(503, error="Mac 暂时无法合成语音，请检查 Mac 的中文语音设置。")
            return
        self.respond(200, "audio/wav", audio)


if __name__ == "__main__":
    print(f"贾维斯 http://127.0.0.1:{PORT}", flush=True)
    with ThreadingHTTPServer(("127.0.0.1", PORT), Handler) as server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
