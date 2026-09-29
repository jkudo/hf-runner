# HF Runner 開発者向けドキュメント

利用方法は [README](../README.ja.md)(英語版は [README.md](../README.md))を参照してください。ここではビルド方法・構成・内部の仕組みをまとめます。

## 構成

| 層 | 技術 |
| --- | --- |
| デスクトップ | Electron 44 + electron-vite |
| UI | React 19 + TypeScript |
| 推論 (GGUF) | llama.cpp `llama-server`(GitHub Releases から実行時に取得) |
| 推論 (safetensors) | Python 3.12 + PyTorch + transformers(uv で自動構築)+ 同梱の `resources/python/server.py` |
| 推論 (画像生成) | stable-diffusion.cpp `sd-server`(GitHub Releases から実行時に取得。`/sdcpp/v1/img_gen` の非同期ジョブ API を使用) |
| 起動ランチャー | C#(`launcher/Launcher.cs`。Windows 標準の .NET Framework の csc.exe でビルド) |
| 配布 | electron-builder(NSIS インストーラー / zip) |

```
src/
  main/            Electron メインプロセス
    hf.ts            Hugging Face Hub API(検索・ファイル一覧・量子化派生の検索・拡散モデルのリモート判定)
    gguf.ts          GGUF ヘッダ解析(ローカル / HTTP Range でリモート)
    safetensors.ts   safetensors ヘッダ + config.json の解析
    downloads.ts     ダウンロードキュー(1 接続は .part、並列 Range は .spart + .spart.json → 完成後リネーム、サイドカー JSON)
    release-runtime.ts GitHub リリースからの推論サーバー取得・展開・バージョン管理(共通)
    runtime.ts       llama.cpp 用の設定と GPU 検出
    sdcpp.ts         stable-diffusion.cpp 用の設定
    python.ts        uv による Python 環境の構築(Python / venv / torch / transformers)と probe
    server.ts        推論サーバー(llama-server / server.py / sd-server)の起動 / ヘルスチェック / 停止
    components.ts    画像生成モデルの部品(VAE / テキストエンコーダー)の状態と取得
    imagegen.ts      画像生成ジョブの投入・進捗・保存
    translate.ts     プロンプト翻訳(選んだ翻訳モデル (shared/translation.ts) を 2 つ目の llama-server で CPU 常駐)
    lan.ts           サーバーモードの入口(0.0.0.0 の固定ポート + API キー → 起動中の推論サーバーへ転送)
    tray.ts          タスクトレイ常駐
    library.ts       ダウンロード済みモデルの一覧
    portable.ts      zip 版(ポータブルモード)の判定
    system.ts / stats.ts / nvidia.ts  RAM / GPU 情報と使用率
    debug.ts         E2E スモークテスト
  preload/         contextBridge(window.api)
  renderer/        React UI(検索・詳細・ライブラリ・チャット・画像生成・設定)
  shared/          共通型、量子化テーブル、拡散モデルの判定と部品カタログ、メモリ見積もり・適合判定
resources/python/
  server.py        transformers モデルを OpenAI 互換 API で提供(標準ライブラリのみで HTTP を実装)
  probe.py         torch / transformers / GPU の状態を JSON で返す
launcher/          起動ランチャー(C#)
scripts/           ランチャーのビルド、パッケージ後の app\ への移動
tests/             vitest
```

## 開発

Node.js 22 以降が必要です。

```bash
npm install
npm run dev        # 開発モード(HMR)
npm run typecheck
npm test           # 単体テスト(リモート GGUF ヘッダ取得テストはネットワークを使用)
npm run build      # out/ に本番ビルド
```

npm 11 の allow-scripts 機構で electron の postinstall がブロックされた場合は、`node node_modules/electron/install.js` を実行してください。

### E2E スモークテスト

画面を自動操作してスクリーンショットを保存します。環境変数で有効になります。

```bash
HFRUNNER_USER_DATA=/path/to/userData HFRUNNER_E2E_DIR=/path/to/shots npx electron .
```

| 変数 | 内容 |
| --- | --- |
| `HFRUNNER_USER_DATA` | 設定・ランタイムの保存先を差し替える(通常利用では不要) |
| `HFRUNNER_E2E_QUERY` | 検索語(既定 `smollm2 135m`) |
| `HFRUNNER_E2E_FORMAT` | 起動するモデルの形式を絞る(`gguf,safetensors,diffusion`) |
| `HFRUNNER_E2E_NAME` | 起動するモデルを名前の部分一致で絞る |
| `HFRUNNER_E2E_IMAGE` | 画像入力対応モデルに貼り付ける画像 |
| `HFRUNNER_E2E_TRANSLATE` | 画像生成の前にプロンプト翻訳を試す(画面の選択肢で全ての翻訳モデルに切り替えて訳し、元のモデルに戻す) |
| `HFRUNNER_E2E_TRANSLATE_SWITCH` | 翻訳モデルのダウンロード中に切り替え、前のダウンロードが止まって最後に選んだモデルだけが取得・起動されることを確かめる(翻訳モデル未取得の環境で使う) |
| `HFRUNNER_E2E_LAN` | サーバーモードとトレイ常駐を有効にして、LAN 経由の API 呼び出しとウィンドウを閉じた後の動作を試す |
| `HFRUNNER_E2E_LANG` | `en` / `ja`: その言語で各ページを撮り、最後に設定画面から言語を切り替えて、画面の状態が残り文言だけが変わるかを確かめる |
| `HFRUNNER_E2E_DETAIL_LAUNCH` | モデル詳細の「起動」ボタンを実際に押す |

E2E の手順は日本語の文言でボタンを探すため、実行中は表示言語を日本語に固定し、終わったら (失敗しても) 元の設定に戻します。

## Windows 向けビルド

Windows 上で:

```powershell
npm ci
npm run dist:win   # dist/HF-Runner-<version>-win-x64.exe (NSIS インストーラー) と -win-x64.zip
```

Linux / WSL 上でビルドする場合は wine が必要です。

### リリースの手順

1. `CHANGELOG.md` の `[Unreleased]` を新しいバージョンの節にし、`package.json` の `version` を上げる
2. 公開用の `main` に開発用ブランチの内容を 1 コミットにまとめて入れ、公開リポジトリへ push する
3. 手元で `npm run dist:win` を実行し、できたインストーラーと zip を動作確認する
4. 公開リポジトリに `v<バージョン>` のリリース(タグ)を作り、`dist/` の exe と zip を載せる。本文は `CHANGELOG.md` のそのバージョンの節で、`GITHUB_REPOSITORY=<所有者>/<リポジトリ> node scripts/release-notes.mjs v<バージョン>` で取り出せる(リンクが絶対 URL になる)

GitHub Actions は使いません(手元でビルドして確認したものをそのまま配る)。

インストーラーはコード署名していません。署名する場合は electron-builder の `win.signtoolOptions` を設定してください。

### 2 段階起動

`HF Runner.exe` は数十 KB のランチャーで、起動画面を出してから Electron 本体 `app\HF Runner App.exe` を起動し、本体のウィンドウが出たら閉じます。本体(約 235MB)は Windows 11 の Smart App Control(評価モード)が初回実行時にプロセス生成を止めて解析するため、画面が出るまで 5〜10 秒かかることがあり、その間も起動画面を出すためです。所要時間はファイルサイズにほぼ比例し、Defender のリアルタイム保護を切っても変わりません。

本体一式は `scripts/nest-app.js`(electron-builder の `artifactBuildStarted` フック)で `app\` に移し、ルートに見える exe はランチャーだけにしています。`build/installer.nsh` はショートカットをランチャーに向け直します。

electron-builder の `portable` ターゲットは使っていません。起動のたびに一時フォルダへ約 300MB を展開するため、起動に数十秒かかるためです。

### ポータブルモード

zip 版は、ルート(ランチャーの隣)に NSIS のアンインストーラー(`Uninstall <名前>.exe`)が無いことで判定し、設定・ランタイム・Python 環境・モデルをすべて `<展開先>\data\` に保存します(`src/main/portable.ts`)。インストーラー版は通常の userData(`%APPDATA%\HF Runner`)とドキュメントの `HFRunner\models` を使います。

アンインストーラーの名前は electron-builder の設定で変わるので決め打ちしません(`isInstalledLayout`)。本体を `HF Runner App.exe` にしたとき名前が `Uninstall HF Runner App.exe` に変わり、決め打ちの判定が外れてインストーラー版がポータブル扱いになったことがあります。インストーラーの上書き更新は旧版のアンインストーラーでインストール先を丸ごと消すため、インストール先の `data\` に置いたデータは更新のたびに消えていました。パスは相対で記録し(ランタイムの `serverRel`、設定の `modelsDir`)、Python の venv は `--relocatable` で作成して、移動後の初回起動時に `pyvenv.cfg` の参照先を直します。

## 内部の仕組み

### メモリ見積もり

`必要メモリ ≒ モデルファイルサイズ + KV キャッシュ + 作業領域`

KV キャッシュは GGUF ヘッダの `block_count × head_count_kv × (key_length + value_length) × 2 bytes × コンテキスト長` で計算します。ヘッダはダウンロード前でも HTTP Range で先頭だけ読んで取得します(取得できない場合はパラメータ数からの概算)。判定は VRAM の 92% / RAM の 85% を上限としています。

safetensors(Transformers)は HF API の `safetensors.total` と `config.json` から同じ式で計算し、重みは 16bit = 2 bytes / 8bit ≈ 1 byte / 4bit ≈ 0.56 byte(埋め込み層は別計上)、作業領域として 1GB + 10% を上乗せします。

### GPU の検出と優先

GPU は llama.cpp の `--list-devices`(GPU 版を入れているとき)と `nvidia-smi` の両方で調べ、名前で 1 つにまとめます(`src/main/system.ts`、`src/shared/gpu.ts` の `mergeGpus`)。どちらも見つからなければ Python (CUDA) の検出結果を使います。

- llama.cpp だけに頼ると、CPU 版を入れている・問い合わせが一時的に失敗したときに GPU が消え、ビルドによって並ぶ GPU も変わる(Vulkan 版は内蔵 GPU も並べ、CUDA 版は NVIDIA だけ)。問い合わせは失敗したら 1 回やり直し、見つからなかった結果は覚えない
- 外付け GPU があれば、内蔵 GPU(Intel UHD / Iris、Radeon Graphics など。VRAM に見えるのはメインメモリの共有分で、外付けより大きく見えることが多い)は推論とメモリ判定に使わない(`usableGpus`)。llama.cpp の起動でも `--device` で外付けだけを指定する(`discreteDevices`)。サイドバーには出さず、設定の「この PC」に「使わない」と表示する
- メモリ判定は、その形式を動かすエンジンが使う GPU で行う(`fitGpus`)。エンジンが CPU 版なら GPU 無し、未インストールのエンジンは GPU 版を入れる前提、Transformers は NVIDIA GPU だけ
- 設定「使用する GPU」(`gpuSelection`)で GPU を手動で選べる。保存するのは GPU のキー(名前 + 同じ名前の中での順番。`gpuKey`)で、エンジンやビルドで番号(Vulkan1 / CUDA0 など)が違っても同じ GPU を指す。起動時に各エンジンの一覧から番号を引き(`selectedIndex`)、llama.cpp は `--device`、stable-diffusion.cpp は `--backend`(`sd-server --list-devices` の名前)、Python は `CUDA_VISIBLE_DEVICES` で指定する。選んだ GPU が見つからなければ自動に戻る。自動のとき sd.cpp は自分で外付け GPU を選ぶので指定しない

### ダウンロード

16MB 以上のファイルは HTTP Range で範囲に分けて並列取得します(既定 4 接続、1〜16)。`.spart` を最終サイズで事前確保し、範囲ごとの進捗を `.spart.json` に保存して、中断後は範囲単位で再開します。Windows では事前確保でゼロ埋めが走らないよう `fsutil sparse setflag` でスパースファイルにします。Range に対応しないサーバーでは 1 接続(`.part` に先頭から追記)に切り替えます。完了時に `<entry>.hfrunner.json`(サイドカー)を書き、ライブラリはこれを元に一覧を作ります。

### サーバーモード

推論サーバー(llama-server / server.py / sd-server)は常に `127.0.0.1` だけで待ち受けます。外部からのリクエストは、メインプロセスの小さな HTTP ゲートウェイ(`src/main/lan.ts`)が `0.0.0.0:<lanPort>`(既定 18000)で受け、`Authorization: Bearer <API キー>`(または `X-API-Key`)を定数時間で照合してから、起動中の推論サーバーへそのまま転送します(ストリーミングもそのまま流す)。

- エンジンごとに外部公開・認証を実装せずに済み、内部のポートがずれたりモデルを切り替えたりしても、外から見える URL とキーは変わらない
- `GET /health` と CORS の事前確認(OPTIONS)だけは認証なし。モデル未起動なら 503
- 認証ヘッダと接続ごとのヘッダは推論サーバーへ渡さない。クライアントが切断したら推論サーバーへの要求も止める
- 翻訳用の 2 つ目の llama-server は公開しない

トレイ常駐(`src/main/tray.ts`)が有効なときは、ウィンドウの close を横取りして隠すだけにし、`window-all-closed` でも終了しません。終了はトレイのメニューから `app.quit()`(`before-quit` で推論サーバーとゲートウェイを止める)。

E2E は `HFRUNNER_E2E_LAN=1` でサーバーモードとトレイ常駐を設定画面から有効にし、LAN 側の IP アドレス経由で API を呼び、ウィンドウを閉じても動き続けることを確かめます。

### 起動コマンドの編集

推論サーバーの起動コマンドは、エンジンごとのひな形(`src/shared/command.ts` の `DEFAULT_COMMANDS`)の `{…}` を置き換えて作ります。各 `*Spec`(`src/main/server.ts`)は引数の配列ではなく差し込み項目の値(`vars`)を返し、`ServerManager.start` が `buildCommand` で実行ファイルと引数にします。

- 設定の `llamaCommand` / `sdCommand` / `pythonCommand` に本文があればそれを、空なら既定を使う。設定画面は既定と同じ内容(`sameCommand`: 引数の並びが同じ)なら空で保存するので、アプリの更新で既定が変わっても編集していない人は追従する
- 本文は `splitArgs`(`src/shared/args.ts`。空白区切り、`"…"` / `'…'` で空白を含められる)で分けてから置き換える。シェルは通さない。値に空白があっても 1 つの引数のまま
- `{threads}` / `{device}` / `{mmproj}` などは 0 個以上の引数に展開する(1 語だけで書いたとき。語の一部に書いたら空白区切りの文字列として埋め込む)
- `{port}` が無い本文は起動しない(起動の確認ができず 30 分待つことになるため)。先頭がオプション、`{小文字}` 形式の不明な項目も同様。JSON の `{"…"}` は項目とみなさない
- 編集した本文を使うのはメインの推論サーバーだけ(`customCommand: true`)。翻訳用の補助サーバーは常に既定
- 実行したコマンドはサーバーログの先頭行に出し、ログが長くなっても先頭に残す。編集した本文で失敗したら、エラーに「既定に戻す」の案内を添える

### 実行できないファイルの判定

公式の llama-server に渡すとクラッシュ・読み込み失敗するファイルは、起動前に止めます(`src/shared/quant.ts` の `standaloneBlock`)。

- 一部のレイヤーしか無い GGUF(投機的デコード用のドラフト)。`blk.N` の数が `block_count` に満たないもの、またはファイル名に `draft` を含むもの。llama-server はエラーではなく 0xC0000005 で落ちる
- 公式に無い ggml 型(100 以上)を使う GGUF、またはファイル名が `PTQ1_0` / `PQ2_0`(PrismML の Ternary Bonsai など)。llama-server は `invalid ggml type` で失敗する

### 画像生成

拡散モデルかどうかはファイルの中身で判定します(`src/shared/diffusion.ts`)。GGUF は `general.architecture`、無い場合や名前が未知の場合はテンソル名の先頭 3 階層、safetensors はキーの先頭 3 階層で、系統(SD1.x / SDXL / FLUX / SD3 / Qwen-Image 2.0 / 2.1 / PE 版)と、VAE・テキストエンコーダーを含む 1 ファイル版かを見分けます。

本体だけのモデルは、系統ごとのカタログ(`COMPONENT_CATALOG`)から VAE とテキストエンコーダーを取得し、`--diffusion-model` + `--vae` / `--clip_l` / `--t5xxl` / `--llm` で起動します。T5-XXL は GGUF 量子化版を既定にしています(fp8 の safetensors は stable-diffusion.cpp の CPU 計算で落ちるため)。stable-diffusion.cpp が読めない dtype(MLX の U32 パック、NVFP4 の U8 重み)は「非対応の形式」として起動を止めます。

生成は `POST /sdcpp/v1/img_gen` でジョブを投入して `/sdcpp/v1/jobs/{id}` をポーリングし、ステップ進捗はサーバーログの `|====| n/m - X.XXs/it` から拾います。生成画像は独自プロトコル `hfimg://images/<名前>` でレンダラーに渡します。
