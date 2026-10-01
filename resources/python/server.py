"""HF Runner: transformers のモデルを OpenAI 互換 API (/v1/chat/completions) で提供する最小サーバー。

標準ライブラリの http.server だけで実装し、依存を torch / transformers に限定している。
llama-server と同じく /health が 503 → 200 になったら利用可能、読み込み失敗時は 500 を返して終了する。
config.json に vision_config がある視覚言語モデルは AutoModelForImageTextToText + AutoProcessor で読み込み、
messages の image_url (data URL) を画像入力として扱う。
"""
import argparse
import base64
import io
import json
import os
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# 表示言語 (アプリが HFRUNNER_LANG=ja|en で渡す)。利用者に見えるメッセージは L("日本語", "English") で両方書く
LANG = os.environ.get("HFRUNNER_LANG", "ja")


def L(ja, en):
    return en if LANG == "en" else ja


parser = argparse.ArgumentParser()
parser.add_argument("--model", required=True, help="モデルフォルダ (config.json と *.safetensors)")
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, default=18081)
parser.add_argument("--precision", choices=["auto", "8bit", "4bit"], default="auto")
parser.add_argument("--max-context", type=int, default=4096)
parser.add_argument("--device", choices=["auto", "cuda", "cpu"], default="auto")
parser.add_argument("--trust-remote-code", action="store_true")
parser.add_argument("--vision", choices=["auto", "on", "off"], default="auto", help="画像入力モデルとして読み込むか (auto = config.json の vision_config で判定)")
parser.add_argument("--alias", default=None)
args = parser.parse_args()


def log(msg):
    print(msg, file=sys.stderr, flush=True)


log(L(f"[hfrunner] python {sys.version.split()[0]}: torch / transformers を読み込み中...", f"[hfrunner] python {sys.version.split()[0]}: loading torch / transformers..."))
import torch  # noqa: E402
import transformers  # noqa: E402
from transformers import (  # noqa: E402
    AutoConfig,
    AutoModelForCausalLM,
    AutoTokenizer,
    StoppingCriteria,
    StoppingCriteriaList,
    TextIteratorStreamer,
)

ALIAS = args.alias or os.path.basename(os.path.normpath(args.model))
state = {
    "loaded": False,
    "error": None,
    "model": None,
    "tok": None,
    "processor": None,
    "vision": False,
    "device": "cpu",
    "dtype": None,
    "n_params": 0,
}
started_at = time.time()
gen_lock = threading.Lock()


def load_model():
    try:
        use_cuda = torch.cuda.is_available() and args.device != "cpu"
        if args.device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError(L("CUDA が利用できません", "CUDA is not available"))
        log(f"[hfrunner] torch {torch.__version__} / transformers {transformers.__version__} / cuda={use_cuda}")
        config = AutoConfig.from_pretrained(args.model, trust_remote_code=args.trust_remote_code)
        vision = args.vision == "on" or (args.vision == "auto" and getattr(config, "vision_config", None) is not None)
        if use_cuda:
            dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        else:
            dtype = torch.bfloat16
        kwargs = {"trust_remote_code": args.trust_remote_code}
        if use_cuda:
            kwargs["device_map"] = "auto"
        if args.precision in ("8bit", "4bit"):
            if not use_cuda:
                raise RuntimeError(L("8bit / 4bit の読み込みには NVIDIA GPU (CUDA) が必要です", "8-bit / 4-bit loading requires an NVIDIA GPU (CUDA)"))
            from transformers import BitsAndBytesConfig

            if args.precision == "8bit":
                kwargs["quantization_config"] = BitsAndBytesConfig(load_in_8bit=True)
            else:
                kwargs["quantization_config"] = BitsAndBytesConfig(
                    load_in_4bit=True,
                    bnb_4bit_compute_dtype=dtype,
                    bnb_4bit_quant_type="nf4",
                    bnb_4bit_use_double_quant=True,
                )
        processor = None
        if vision:
            # 視覚言語モデル: processor (画像前処理 + トークナイザ) と画像対応のモデルクラスで読む
            from transformers import AutoProcessor

            try:
                from transformers import AutoModelForImageTextToText as ModelClass
            except ImportError:  # transformers < 4.46
                from transformers import AutoModelForVision2Seq as ModelClass

            processor = AutoProcessor.from_pretrained(args.model, trust_remote_code=args.trust_remote_code)
            tok = getattr(processor, "tokenizer", None) or AutoTokenizer.from_pretrained(args.model, trust_remote_code=args.trust_remote_code)
        else:
            ModelClass = AutoModelForCausalLM
            tok = AutoTokenizer.from_pretrained(args.model, trust_remote_code=args.trust_remote_code)
        log(L(f"[hfrunner] モデルを読み込み中: {args.model} (precision={args.precision}, dtype={dtype}, vision={vision})", f"[hfrunner] Loading model: {args.model} (precision={args.precision}, dtype={dtype}, vision={vision})"))
        try:
            model = ModelClass.from_pretrained(args.model, dtype=dtype, **kwargs)
        except TypeError:
            model = ModelClass.from_pretrained(args.model, torch_dtype=dtype, **kwargs)
        model.eval()
        if tok.pad_token_id is None and tok.eos_token_id is not None:
            tok.pad_token = tok.eos_token
        state.update(
            model=model,
            tok=tok,
            processor=processor,
            vision=vision,
            device=str(next(model.parameters()).device),
            dtype=str(dtype).replace("torch.", ""),
            n_params=sum(p.numel() for p in model.parameters()),
        )
        state["loaded"] = True
        log(L(f"[hfrunner] 読み込み完了: device={state['device']} params={state['n_params'] / 1e9:.2f}B vision={vision} ({time.time() - started_at:.1f}s)", f"[hfrunner] Loaded: device={state['device']} params={state['n_params'] / 1e9:.2f}B vision={vision} ({time.time() - started_at:.1f}s)"))
    except Exception as e:  # noqa: BLE001
        state["error"] = f"{type(e).__name__}: {e}"
        traceback.print_exc()
        log(L(f"[hfrunner] 読み込み失敗: {state['error']}", f"[hfrunner] Failed to load: {state['error']}"))

        def die():
            time.sleep(3)
            os._exit(1)

        threading.Thread(target=die, daemon=True).start()


class StopOnEvent(StoppingCriteria):
    """停止要求 (クライアント切断 / 停止ボタン) を generate に伝える。呼び出し回数 = 生成トークン数"""

    def __init__(self, event):
        self.event = event
        self.count = 0

    def __call__(self, input_ids, scores, **kwargs):
        self.count += 1
        return self.event.is_set()


class ThinkSplitter:
    """<think>...</think> を reasoning_content として分離するストリーミング用の分割器"""

    OPEN, CLOSE = "<think>", "</think>"

    def __init__(self):
        self.buf = ""
        self.thinking = False

    def _kind(self):
        return "reasoning" if self.thinking else "content"

    def feed(self, text):
        self.buf += text
        out = []
        while self.buf:
            tag = self.CLOSE if self.thinking else self.OPEN
            i = self.buf.find(tag)
            if i >= 0:
                if i > 0:
                    out.append((self._kind(), self.buf[:i]))
                self.buf = self.buf[i + len(tag) :]
                self.thinking = not self.thinking
                continue
            # 末尾がタグの途中で切れている可能性があれば保留する
            keep = 0
            for k in range(min(len(tag) - 1, len(self.buf)), 0, -1):
                if tag.startswith(self.buf[-k:]):
                    keep = k
                    break
            emit = self.buf[: len(self.buf) - keep] if keep else self.buf
            if emit:
                out.append((self._kind(), emit))
            self.buf = self.buf[len(self.buf) - keep :] if keep else ""
            break
        return out

    def flush(self):
        out = [(self._kind(), self.buf)] if self.buf else []
        self.buf = ""
        return out


def decode_image(url):
    """OpenAI 形式の image_url (data:image/...;base64,...) を PIL.Image にする。http(s) はオフライン運用なので受け付けない"""
    from PIL import Image

    if not url.startswith("data:"):
        raise ValueError(L("画像は data URL (base64) で送ってください", "Send images as data URLs (base64)"))
    _, _, payload = url.partition(",")
    img = Image.open(io.BytesIO(base64.b64decode(payload)))
    return img.convert("RGB")


def normalize_messages(messages):
    """OpenAI 形式の messages を {role, content(str), images([PIL])} に正規化する"""
    out = []
    for m in messages:
        role = m.get("role", "user")
        content = m.get("content", "")
        images = []
        if isinstance(content, list):
            texts = []
            for part in content:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "image_url":
                    url = part.get("image_url")
                    url = url.get("url", "") if isinstance(url, dict) else str(url or "")
                    if url:
                        images.append(decode_image(url))
                elif part.get("type") in ("text", "input_text") or "text" in part:
                    texts.append(part.get("text", ""))
            content = "".join(texts)
        if role in ("user", "assistant", "system") and content is not None:
            out.append({"role": role, "content": str(content), "images": images})
    return out


def encode_text(tok, msgs, tmpl):
    """テキストのみ: チャットテンプレートでトークン化 (tmpl はテンプレートに渡す変数。enable_thinking など)"""
    plain = [{"role": m["role"], "content": m["content"]} for m in msgs]
    if getattr(tok, "chat_template", None):
        out = tok.apply_chat_template(plain, add_generation_prompt=True, return_tensors="pt", return_dict=True, **tmpl)
        ids = out["input_ids"] if hasattr(out, "keys") else out
    else:
        text = "".join(f"{m['role'].capitalize()}: {m['content']}\n" for m in plain) + "Assistant:"
        ids = tok(text, return_tensors="pt")["input_ids"]
    return ids


def input_budget(max_new):
    """入力 (会話の履歴) に使えるトークン数。出力の分を空けるが、最大出力トークンがとても大きくても (999999 など)
    コンテキストの半分までしか空けない (以前は入力が 64 トークンまで削られ、システムプロンプトや履歴が消えていた)"""
    return max(64, args.max_context - min(max_new, args.max_context // 2))


def build_text_inputs(msgs, max_new, tmpl):
    """コンテキスト長に収まるよう、古いメッセージから落としてトークン化する"""
    tok = state["tok"]
    budget = input_budget(max_new)
    msgs = list(msgs)
    ids = encode_text(tok, msgs, tmpl)
    while ids.shape[1] > budget and len(msgs) > 1:
        idx = 1 if msgs[0]["role"] == "system" and len(msgs) > 1 else 0
        del msgs[idx]
        ids = encode_text(tok, msgs, tmpl)
    if ids.shape[1] > budget:
        ids = ids[:, -budget:]
    return {"input_ids": ids, "attention_mask": torch.ones_like(ids)}


def encode_with_processor(msgs, tmpl):
    """視覚言語モデル: processor のチャットテンプレート (chat_template.json) で {type: image} の位置に画像を差し込み、画像とまとめて前処理する。
    テキストのみでもトークナイザではなく processor のテンプレートを使う (トークナイザ側にテンプレートが無いモデルがあるため)"""
    processor = state["processor"]
    hf_msgs = []
    images = []
    for m in msgs:
        parts = [{"type": "image"} for _ in m["images"]]
        images.extend(m["images"])
        if m["content"]:
            parts.append({"type": "text", "text": m["content"]})
        hf_msgs.append({"role": m["role"], "content": parts})
    prompt = processor.apply_chat_template(hf_msgs, add_generation_prompt=True, tokenize=False, **tmpl)
    if images:
        return dict(processor(text=[prompt], images=images, return_tensors="pt"))
    try:
        return dict(processor(text=[prompt], return_tensors="pt"))
    except Exception:  # noqa: BLE001 - 画像なしを受け付けない processor
        return dict(state["tok"](prompt, return_tensors="pt"))


def build_vision_inputs(msgs, max_new, tmpl):
    """コンテキスト長に収まるよう、古いメッセージ (画像込み) から落とす"""
    budget = input_budget(max_new)
    msgs = list(msgs)
    inputs = encode_with_processor(msgs, tmpl)
    while inputs["input_ids"].shape[1] > budget and len(msgs) > 1:
        idx = 1 if msgs[0]["role"] == "system" and len(msgs) > 1 else 0
        del msgs[idx]
        inputs = encode_with_processor(msgs, tmpl)
    return inputs


def vocab_id(tok, token):
    """語彙にあるトークンの ID (無ければ None)"""
    tid = tok.get_vocab().get(token)
    return int(tid) if tid is not None else None


class ThinkBudget(StoppingCriteria):
    """思考 (<think> … </think>) が上限のトークン数に達したら生成を止める。止めたら呼び出し側が </think> を足して回答を続けさせる
    (llama.cpp の thinking_budget_tokens と同じ動き)"""

    def __init__(self, prompt_len, budget, start_id, end_id, thinking_at_start):
        self.prompt_len = prompt_len
        self.budget = budget
        self.start_id = start_id
        self.end_id = end_id
        self.thinking_at_start = thinking_at_start
        self.hit = False

    def __call__(self, input_ids, scores, **kwargs):
        gen = input_ids[0, self.prompt_len :]
        if (gen == self.end_id).any():
            return False  # 思考は終わっている
        if not (self.thinking_at_start or (self.start_id is not None and bool((gen == self.start_id).any()))):
            return False  # 思考していない (そのまま回答している)
        if gen.shape[0] > self.budget:
            self.hit = True
            return True
        return False


def prompt_ends_in_thinking(ids, start_id, end_id):
    """プロンプトの末尾が思考の途中か (テンプレートが生成の頭に <think> を入れるモデル)"""
    if start_id is None:
        return False
    tail = ids[0, -8:].tolist()
    if start_id not in tail:
        return False
    last_start = len(tail) - 1 - tail[::-1].index(start_id)
    return end_id not in tail[last_start:]


def run_generate(inputs, max_new, extra_criteria, params, stop_event, on_piece):
    """generate を別スレッドで回し、出力を on_piece に流す。生成した列 (プロンプト込み) と生成トークン数を返す"""
    model, tok = state["model"], state["tok"]
    streamer = TextIteratorStreamer(tok, skip_prompt=True, skip_special_tokens=True)
    crit = StopOnEvent(stop_event)
    temp = params["temperature"]
    gen_kwargs = dict(
        **inputs,
        streamer=streamer,
        max_new_tokens=max_new,
        stopping_criteria=StoppingCriteriaList([crit, *extra_criteria]),
        pad_token_id=tok.pad_token_id,
        do_sample=temp > 0,
    )
    if temp > 0:
        gen_kwargs["temperature"] = temp
        gen_kwargs["top_p"] = params["top_p"]
    result = {}

    def run():
        try:
            with torch.inference_mode():
                result["seq"] = model.generate(**gen_kwargs)
        except Exception as e:  # noqa: BLE001
            result["error"] = e
            traceback.print_exc()
            streamer.end()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    for piece in streamer:
        if piece:
            on_piece(piece)
    thread.join()
    if "error" in result:
        raise result["error"]
    seq = result["seq"]
    return seq, int(seq.shape[1] - inputs["input_ids"].shape[1])


def generate(msgs, params, stop_event, on_piece):
    model, tok = state["model"], state["tok"]
    has_images = any(m["images"] for m in msgs)
    if has_images and not state["vision"]:
        raise ValueError(L("このモデルは画像入力に対応していません", "This model does not support image input"))
    tmpl = params["template_kwargs"]
    inputs = build_vision_inputs(msgs, params["max_tokens"], tmpl) if state["vision"] else build_text_inputs(msgs, params["max_tokens"], tmpl)
    inputs = {k: (v.to(model.device) if hasattr(v, "to") else v) for k, v in inputs.items()}
    prompt_n = int(inputs["input_ids"].shape[1])
    # 出力はコンテキストの残りまで (最大出力トークンがそれより大きければ、そこで止まる = "length")
    limit = max(1, min(params["max_tokens"], args.max_context - prompt_n))

    # 思考の上限 (thinking_budget_tokens)。テキストのみのモデルで、<think> / </think> がトークンとしてあるときだけ
    budget = params["thinking_budget"]
    start_id, end_id = vocab_id(tok, "<think>"), vocab_id(tok, "</think>")
    criteria = []
    if budget is not None and budget >= 0 and end_id is not None and not state["vision"]:
        think = ThinkBudget(prompt_n, budget, start_id, end_id, prompt_ends_in_thinking(inputs["input_ids"], start_id, end_id))
        criteria.append(think)
    else:
        think = None

    t0 = time.time()
    seq, n = run_generate(inputs, limit, criteria, params, stop_event, on_piece)
    if think is not None and think.hit and not stop_event.is_set():
        # 思考を打ち切り、</think> を足して回答を続けさせる
        close_text = "\n</think>\n\n"
        on_piece(close_text)
        close_ids = tok(close_text, add_special_tokens=False, return_tensors="pt")["input_ids"].to(seq.device)
        ids = torch.cat([seq, close_ids], dim=1)
        rest = limit - n - close_ids.shape[1]
        n += close_ids.shape[1]
        if rest > 0:
            _, n2 = run_generate({"input_ids": ids, "attention_mask": torch.ones_like(ids)}, rest, [], params, stop_event, on_piece)
            n += n2
    elapsed = time.time() - t0
    return {"prompt_n": prompt_n, "predicted_n": n, "elapsed": elapsed, "finish": "length" if n >= limit else "stop"}


class Handler(BaseHTTPRequestHandler):
    server_version = "hfrunner-transformers"

    def log_message(self, fmt, *a):  # noqa: N802
        log("[http] " + fmt % a)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):  # noqa: N802
        path = self.path.split("?")[0]
        if path == "/health":
            if state["error"]:
                self._json(500, {"status": "error", "error": {"message": state["error"]}})
            elif not state["loaded"]:
                self._json(503, {"status": "loading", "error": {"message": "Loading model"}})
            else:
                self._json(200, {"status": "ok"})
        elif path in ("/v1/models", "/models"):
            self._json(200, {"object": "list", "data": [{"id": ALIAS, "object": "model", "owned_by": "hfrunner"}]})
        elif path == "/props":
            self._json(
                200,
                {
                    "model_alias": ALIAS,
                    "model_path": args.model,
                    "engine": "transformers",
                    "device": state["device"],
                    "dtype": state["dtype"],
                    "precision": args.precision,
                    "n_params": state["n_params"],
                    "max_context": args.max_context,
                    "vision": state["vision"],
                    "modalities": {"vision": state["vision"], "audio": False},
                    "build_info": f"transformers {transformers.__version__} / torch {torch.__version__}",
                },
            )
        else:
            self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):  # noqa: N802
        path = self.path.split("?")[0]
        if path not in ("/v1/chat/completions", "/chat/completions"):
            return self._json(404, {"error": {"message": "not found"}})
        if not state["loaded"]:
            return self._json(503, {"error": {"message": state["error"] or "Loading model"}})
        length = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(length) or b"{}")
        except ValueError:
            return self._json(400, {"error": {"message": "invalid JSON"}})
        try:
            msgs = normalize_messages(req.get("messages") or [])
        except Exception as e:  # noqa: BLE001
            return self._json(400, {"error": {"message": L(f"画像を読み取れません: {e}", f"Could not read the image: {e}")}})
        if not msgs:
            return self._json(400, {"error": {"message": "messages is empty"}})
        # チャットテンプレートに渡す変数 (enable_thinking など)。OpenAI 形式の reasoning_effort もテンプレートの変数として渡す
        tmpl = req.get("chat_template_kwargs") if isinstance(req.get("chat_template_kwargs"), dict) else {}
        if isinstance(req.get("reasoning_effort"), str) and "reasoning_effort" not in tmpl:
            tmpl = {**tmpl, "reasoning_effort": req["reasoning_effort"]}
        budget = req.get("thinking_budget_tokens")
        params = {
            "temperature": float(req.get("temperature", 0.7) or 0),
            "top_p": float(req.get("top_p", 0.95) or 0.95),
            "max_tokens": int(req.get("max_tokens") or req.get("max_completion_tokens") or 1024),
            "template_kwargs": tmpl,
            # 思考の上限トークン数 (llama.cpp と同じ名前)。-1 / 未指定は無制限
            "thinking_budget": int(budget) if isinstance(budget, (int, float)) and budget >= 0 else None,
        }
        if not gen_lock.acquire(timeout=0.2):
            return self._json(429, {"error": {"message": L("別の生成が実行中です", "Another generation is in progress")}})
        try:
            if req.get("stream"):
                self._stream(msgs, params)
            else:
                self._complete(msgs, params)
        finally:
            gen_lock.release()

    def _complete(self, msgs, params):
        parts = []
        try:
            stats = generate(msgs, params, threading.Event(), parts.append)
        except ValueError as e:
            return self._json(400, {"error": {"message": str(e)}})
        text = "".join(parts)
        self._json(
            200,
            {
                "id": "chatcmpl-" + uuid.uuid4().hex[:24],
                "object": "chat.completion",
                "created": int(time.time()),
                "model": ALIAS,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": stats["finish"]}],
                "usage": {"prompt_tokens": stats["prompt_n"], "completion_tokens": stats["predicted_n"], "total_tokens": stats["prompt_n"] + stats["predicted_n"]},
            },
        )

    def _stream(self, msgs, params):
        cid = "chatcmpl-" + uuid.uuid4().hex[:24]
        created = int(time.time())
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        stop_event = threading.Event()
        splitter = ThinkSplitter()

        def send(obj):
            try:
                self.wfile.write(("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8"))
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                stop_event.set()

        def chunk(delta, finish=None):
            return {"id": cid, "object": "chat.completion.chunk", "created": created, "model": ALIAS, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}

        def emit(pairs):
            for kind, text in pairs:
                send(chunk({"content": text} if kind == "content" else {"reasoning_content": text}))

        send(chunk({"role": "assistant", "content": ""}))
        try:
            stats = generate(msgs, params, stop_event, lambda piece: emit(splitter.feed(piece)))
            emit(splitter.flush())
            send(chunk({}, stats["finish"]))
            n, el = stats["predicted_n"], stats["elapsed"]
            send(
                {
                    "id": cid,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": ALIAS,
                    "choices": [],
                    "usage": {"prompt_tokens": stats["prompt_n"], "completion_tokens": n, "total_tokens": stats["prompt_n"] + n},
                    "timings": {"prompt_n": stats["prompt_n"], "predicted_n": n, "predicted_ms": el * 1000, "predicted_per_second": n / max(el, 1e-6)},
                }
            )
            try:
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except OSError:
                pass
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            send({"error": {"message": f"{type(e).__name__}: {e}"}})


def main():
    threading.Thread(target=load_model, daemon=True).start()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    log(f"[hfrunner] listening on http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
