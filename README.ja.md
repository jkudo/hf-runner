# HF Runner

[English](README.md) | 日本語

**Hugging Face のモデルを探して、ダウンロードして、そのまま自分の PC で動かす** Windows 向けデスクトップアプリです。

コマンドや Python の知識は不要です。モデルを検索すると、この PC のメモリで動くかどうかを色で教えてくれて、ボタン 1 つでダウンロードからチャット・画像生成まで進めます。推論はすべて PC の中で行い、入力した内容が外部に送られることはありません。

- 💬 **チャット** — Qwen、Gemma、Llama など、テキスト生成モデルと会話
- 🖼️ **画像を見せて質問** — 視覚言語モデルに画像を貼り付けて内容を尋ねる
- 🎨 **画像生成** — Stable Diffusion / SDXL / FLUX.1 / Qwen-Image で画像を作る(日本語など英語以外のプロンプトの自動英訳つき)

> 画面は日本語と英語に対応しています(OS の言語で自動選択。「設定 → 表示言語」で切り替え可)。HF Runner は個人開発の非公式アプリで、Hugging Face 社とは関係ありません。

| モデルを探す | チャット |
| --- | --- |
| ![モデルを探す: リポジトリのファイルごとに、この PC で動くかを表示](docs/images/screenshot-search.png) | ![ローカルのモデルとチャット](docs/images/screenshot-chat.png) |

(スクリーンショットは英語表示です)

## 特長

- **動くかどうかが先に分かる** — リポジトリ内のファイル(Q4_K_M / Q8_0 など)ごとに、この PC の RAM / VRAM で「GPU に全て載る」「一部を GPU に載せて実行」「CPU で実行」「メモリ不足の可能性」を表示。ダウンロード前にファイルの先頭だけを読んで判定します
- **エンジンは自動で用意** — 推論エンジン([llama.cpp](https://github.com/ggml-org/llama.cpp) / [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) / Python + Transformers)は、必要になったときにアプリが公式配布物を取得します。GPU に合わせて Vulkan / CUDA / CPU を選べます
- **速くて止めても大丈夫なダウンロード** — 大きなファイルは複数の接続で並列にダウンロード。中断しても続きから再開できます
- **画像生成に必要な部品も自動で** — FLUX.1 や Qwen-Image のように本体だけが配布されているモデルは、必要な VAE・テキストエンコーダーを一緒に取得します
- **動かないファイルは事前に知らせる** — 投機的デコード用のドラフトや独自形式の量子化など、そのままでは動かないファイルは理由を表示してダウンロード・起動を止めます
- **フォルダごと持ち運べる** — zip 版はアプリ・エンジン・モデルを 1 つのフォルダにまとめて保存します。USB メモリや別の場所に移しても動きます
- **他のアプリからも使える** — 起動中のモデルは OpenAI 互換 API(`http://127.0.0.1:18080/v1`)としても利用できます。18080 が他のアプリに使われているときは 18081 以降の空いている番号を使い、実際の番号は「ライブラリ」の実行中のモデル欄に表示します(既定の番号は「設定」で変更できます)
- **サーバーモード** — 同じネットワークの他の PC・スマートフォン・アプリから、API キー付きで起動中のモデルを使えます。タスクトレイに常駐させれば、ウィンドウを閉じても動き続けます

## 動作環境

| | 最低 | 推奨 |
| --- | --- | --- |
| OS | Windows 10 / 11(64 bit) | Windows 11 |
| メモリ | 8 GB | 16 GB 以上 |
| GPU | なくても動作(CPU で実行) | NVIDIA / AMD / Intel の GPU(VRAM 6 GB 以上) |
| ディスク | モデルごとに 1〜20 GB 程度 | SSD |

動かせるモデルの大きさはメモリで決まります。目安として、RAM 16 GB なら 7〜8B クラスの Q4_K_M(約 5 GB)が快適に動きます。画像生成は GPU があると大幅に速くなります(CPU だと 1 枚に数分かかります)。

## インストール

[Releases](../../releases) から次のどちらかをダウンロードします。バージョンごとの変更点は [CHANGELOG.md](CHANGELOG.md)(英語)にあります。

| ファイル | 使い方 |
| --- | --- |
| `HF-Runner-<version>-win-x64.exe` | **インストーラー版**。実行するとインストールされ、スタートメニューに登録されます |
| `HF-Runner-<version>-win-x64.zip` | **インストール不要版**。任意のフォルダに展開して `HF Runner.exe` を実行します |

zip 版は **`C:\Tools\HF Runner\` のような浅いフォルダ**に展開してください。深いフォルダ(デスクトップの奥など)に置くと、Python エンジンのインストールが Windows のパス長の上限に引っかかることがあります。

### 初回起動の注意

- **「Windows によって PC が保護されました」と表示される場合** — アプリはコード署名していないため、SmartScreen の警告が出ます。「詳細情報」→「実行」で起動できます
- **最初の 1 回だけ起動に 5〜10 秒かかることがあります** — Windows 11 のスマート アプリ コントロールが、新しいアプリを初めて実行するときに内容を確認するためです。この間も起動画面が表示されます。2 回目以降はすぐに起動します

## 使い方

### 1. 推論エンジンを入れる

初回起動時に画面上部に表示される案内から、エンジンを選んで「インストール」を押します(後から「設定」でも追加できます)。

| エンジン | 使うモデル | 備考 |
| --- | --- | --- |
| **llama.cpp**(おすすめ) | GGUF 形式 | 軽くて速い。まずはこれ |
| Python / Transformers | safetensors 形式(変換前の元のモデル) | 数 GB の Python 環境を自動で構築します |
| stable-diffusion.cpp | 画像生成モデル | 「画像生成」を使うときに |

llama.cpp と stable-diffusion.cpp は GPU の種類を選べます。

| 選択肢 | 対象 |
| --- | --- |
| **Vulkan**(推奨) | NVIDIA / AMD / Intel の GPU 全般。追加のインストール不要 |
| CUDA 12 / 13 | NVIDIA GPU で最速 |
| CPU | GPU が無い、または GPU でうまく動かないとき |

### 2. モデルを探してダウンロード

「モデルを探す」で名前を入れて検索します(例: `Qwen3`、`gemma`、`Llama-3.1`)。チェックボックスで「テキスト生成」「画像入力」「画像生成」を絞り込めます。

モデルを選ぶと、ファイルごとにサイズと「動くかどうか」が色付きで並びます。**迷ったら Q4_K_M** がサイズと品質のバランスの良い選択です。緑(GPU に全て載る)か黄緑(一部を GPU)のものを選んで「ダウンロード」を押してください。

- GGUF が無いモデルを選ぶと、同じモデルの GGUF 版を探して表示します
- 利用規約への同意が必要なモデル(gated)は、「設定」に Hugging Face のアクセストークンを入れるとダウンロードできます

### 3. 起動してチャット

「ライブラリ」で「▶ 起動」を押すと、モデルを読み込んで「チャット」に移ります。読み込みの進み具合はバーで表示されます。

- 思考(`<think>`)を出力するモデルは、思考部分を折りたたんで表示します。考える時間が長すぎるときは、「パラメータ」の「思考」を「短め」「最小」「オフ」にすると早く回答が出ます
- 画像入力対応のモデルでは、画像を貼り付け・ドロップ・ボタンで添付できます
- 使い終わったら「⏏ 解放」でメモリから降ろします
- エンジンの起動コマンドは「設定」の各エンジンの「起動コマンド」で編集できます(例: llama.cpp に `-ctk q8_0 -ctv q8_0` を足す、`-c {ctx}` を `-c 8192` に変える)。`{model}` や `{port}` などの差し込み項目は起動のたびにモデルのパスやポートに置き換わります。「既定に戻す」でいつでも元に戻せます

### 4. 画像生成

stable-diffusion.cpp を入れて、検索で「画像生成」にチェックを入れて探します(例: `stable-diffusion-v1-5`、`FLUX.1-schnell`)。ダウンロード後、「画像生成」ページでモデルを起動し、プロンプトを入れて「生成」を押します。

- **日本語など英語以外のプロンプトもそのまま使えます** — 「プロンプトを英語に翻訳する」にチェックを入れると、翻訳用の多言語モデルを取得して、日本語・中国語・韓国語・フランス語などのプロンプトを生成のたびに英語に変換します(llama.cpp が必要です)。翻訳モデルはチェックの横で選べます: **Qwen3-4B-Instruct-2507**(推奨、約 2.3 GB。多くの言語を正確に訳す)/ **Qwen3-1.7B**(軽量、約 1.0 GB。速くメモリも少ないが、ドイツ語・スペイン語などで訳し間違いがある)。英語の文字だけで書いた文(アクセント記号の無いフランス語など)は英語とみなして自動では翻訳しませんが、「英訳を確認」から翻訳して置き換えられます
- FLUX.1 などの部品(VAE・テキストエンコーダー)は、モデルと一緒に自動でダウンロードされます。部品は複数のモデルで共有されます
- 生成した画像はパラメータ付きで保存され、「この設定を使う」で同じ条件をもう一度使えます

### 5. 他の PC やアプリから使う(サーバーモード)

「設定 → サーバーモード」で「同じネットワークの他の PC・スマートフォン・アプリから、起動中のモデルを使えるようにする」にチェックを入れると、次の情報が表示されます。

- **接続先 URL** — 例: `http://192.168.1.10:18000/v1`(ポートは固定。設定で変更可)
- **API キー** — 有効にしたときに自動で作られます。「作り直す」で変更できます

OpenAI 互換のアプリや SDK なら、base URL にこの URL、API キーにこのキーを入れるだけで使えます。

```python
from openai import OpenAI
client = OpenAI(base_url="http://192.168.1.10:18000/v1", api_key="hfr-...")
print(client.chat.completions.create(model="local", messages=[{"role": "user", "content": "こんにちは"}]).choices[0].message.content)
```

- HF Runner で起動しているモデルがそのまま使われます。モデルを切り替えても URL とキーは変わりません(モデルが起動していないときは 503 を返します)
- 初めて有効にしたときに Windows ファイアウォールの確認が出たら、「プライベート ネットワーク」を許可してください。**カフェなどの公共のネットワークでは有効にしないでください**
- 「タスクトレイに常駐」にチェックを入れると、ウィンドウを閉じても終了せずにトレイで動き続けます。終了はトレイのアイコンを右クリックして「終了」です

## 対応しているモデル

| 種類 | 形式 | エンジン |
| --- | --- | --- |
| テキスト生成 | GGUF | llama.cpp |
| テキスト生成 | safetensors(`config.json` あり) | Python / Transformers |
| 画像入力(視覚言語モデル) | GGUF + mmproj / safetensors | llama.cpp / Transformers |
| 画像生成 | Stable Diffusion 1.x / 2.x / SDXL(1 ファイル版)、FLUX.1、SD3.5、Qwen-Image / Qwen-Image 2.1(GGUF / safetensors) | stable-diffusion.cpp |

すでに持っている `.gguf` ファイルを、モデルフォルダに置くだけでもライブラリに表示されます。

### 対応していないもの

- 投機的デコード用の **ドラフトモデル**(`-draft-` など、本体の一部だけのファイル)
- 公式の llama.cpp に無い **独自形式の量子化**(PrismML の Ternary Bonsai `PTQ1_0` / `PQ2_0` など)
- Apple MLX 用・NVFP4 など、stable-diffusion.cpp が読めない形式の画像生成モデル
- Diffusers 形式(`model_index.json` + フォルダ分け)の画像生成モデル、LoRA、画像編集(img2img)
- 音声、動画、`pytorch_model.bin` だけのリポジトリ

これらは検索結果やライブラリに理由が表示され、ダウンロード・起動できないようになっています。

## データの保存場所

| 内容 | インストーラー版 | zip 版 |
| --- | --- | --- |
| モデル | `ドキュメント\HFRunner\models\`(設定で変更可) | `<展開先>\data\models\` |
| エンジン・設定・生成画像 | `%APPDATA%\HF Runner\` | `<展開先>\data\` |

モデルは `<作者>\<リポジトリ名>\` のフォルダに保存されます。不要になったモデルは「ライブラリ」の 🗑 で削除できます。

## うまく動かないとき

| 症状 | 対処 |
| --- | --- |
| 起動中にメモリ不足で止まる | より小さい量子化(Q4_K_M → Q3_K_M / IQ3_XXS など)を選ぶ。「設定 → GPU に載せるレイヤー数」を減らす |
| 「推論サーバーが終了しました」と出る | エラー欄に原因の説明が出ます。「サーバーログを表示」で詳細を確認してください |
| 新しいモデルが読み込めない(unknown model architecture) | 「設定」で llama.cpp を更新する |
| GPU で動かない | 「設定」でエンジンを CPU 版に切り替えて試す |
| 使ってほしい GPU で動かない(内蔵 GPU で動くなど) | 「設定 → 使用する GPU」で GPU を選ぶ(既定は外付け GPU を優先) |
| 画像生成がとても遅い | CPU で動いています。stable-diffusion.cpp を Vulkan / CUDA 版で入れ直す |
| zip 版で Python エンジンのインストールに失敗する | 展開先を `C:\Tools\HF Runner\` のような短いパスに移す |

## 注意事項

- **モデルのライセンスはモデルごとに異なります。** 利用前に各モデルのページでライセンスと利用規約を確認してください。このアプリはモデルを配布しておらず、推論エンジンやモデルは実行時に GitHub / Hugging Face の配布元から取得します
- 起動中のモデルの API(`127.0.0.1`)は、この PC からだけアクセスできます。他の機器から使えるのは、サーバーモードを有効にしたとき(API キーが必要)だけです

### 自動で取得するモデルのライセンス

次のモデルは、画像生成の部品やプロンプト翻訳のためにアプリが自動でダウンロードします。**商用利用に制限があるもの**は、ダウンロード前と「部品」欄に ⚠ で表示します。

| 用途 | 取得元 | ライセンス |
| --- | --- | --- |
| FLUX.1 の VAE / CLIP-L / T5-XXL | `second-state/FLUX.1-schnell-GGUF`、`comfyanonymous/flux_text_encoders`、`city96/t5-v1_1-xxl-encoder-gguf` | Apache-2.0 |
| Qwen-Image の VAE / テキストエンコーダー | `QuantStack/Qwen-Image-GGUF`、`mradermacher/Qwen2.5-VL-7B-Instruct-GGUF`(元モデルは Apache-2.0) | Apache-2.0 |
| Qwen-Image 2.1 のテキストエンコーダー | `Qwen/Qwen3-VL-8B-Instruct-GGUF` | Apache-2.0 |
| **Qwen-Image 2.1 の VAE、PE 版のテキストエンコーダー** | `Comfy-Org/Qwen-Image-2.1` | **[Qwen Research License](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE) — 非商用(研究・評価)に限る** |
| **SD3.5 の CLIP-G** | `Comfy-Org/stable-diffusion-3.5-fp8` | **[Stability AI Community License](https://huggingface.co/stabilityai/stable-diffusion-3.5-large/blob/main/LICENSE.md) — 商用利用は登録が必要、年間収益 100 万ドル超は別契約** |
| プロンプト翻訳 | `unsloth/Qwen3-4B-Instruct-2507-GGUF`、`unsloth/Qwen3-1.7B-GGUF`(選んだ方だけ取得) | Apache-2.0 |

ライセンスの表記は 2026 年 9 月時点のものです。最新の条件は各リポジトリで確認してください。

## 開発者向け

ビルド方法・構成・内部の仕組みは [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) を参照してください。

## ライセンス

[MIT License](LICENSE) — Copyright (c) 2026 HF Runner

配布物には次のソフトウェアが含まれます。ライセンス文は配布物に同梱しています(`LICENSE.electron.txt`、`LICENSES.chromium.html`、`app\resources\app.asar` 内の各 `LICENSE`、UI の JS 末尾の著作権表示)。

| ソフトウェア | ライセンス |
| --- | --- |
| [Electron](https://www.electronjs.org/) / Chromium | MIT / 各種(`LICENSES.chromium.html`) |
| [React](https://react.dev/)(react, react-dom, scheduler) | MIT |
| [extract-zip](https://github.com/max-mapper/extract-zip) とその依存(yauzl, debug など) | BSD-2-Clause / MIT / ISC |

次のソフトウェアは利用者の PC が実行時に公式の配布元から取得します(このアプリには含まれません)。

| ソフトウェア | ライセンス |
| --- | --- |
| [llama.cpp](https://github.com/ggml-org/llama.cpp) | MIT |
| [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) | MIT |
| [uv](https://github.com/astral-sh/uv) | MIT / Apache-2.0 |
| [PyTorch](https://pytorch.org/) / torchvision | BSD-3-Clause |
| [Transformers](https://github.com/huggingface/transformers)、accelerate、safetensors、sentencepiece | Apache-2.0 |
| bitsandbytes、tiktoken | MIT |
| Pillow | MIT-CMU (HPND) |
| protobuf | BSD-3-Clause |
